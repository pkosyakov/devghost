# Исследование качества оценки трудозатрат на маленьких коммитах

**Дата**: 2026-03-27
**Автор**: Enigma (Hands)
**Статус**: Пересмотрено после аудита GT и true pipeline replay

---

## 1. Цель

Понять, почему пайплайн оценки трудозатрат плохо работает на коммитах размером 3-30 файлов, и отделить три разные проблемы:

1. Насколько был корректен сам ground truth.
2. Насколько помогают кастомные калибровочные prompt-ы.
3. Что реально выдаёт **production pipeline end-to-end**, а не его упрощённая prompt-only реплика.

Текущая версия отчёта заменяет все предыдущие интерпретации этого набора. Здесь production-выводы основаны не на synthetic 2-pass harness, а на реальном `run_commit()` replay из `run_v16_pipeline.py`.

## 2. Что пришлось исправить

### 2.1 GT оказался смещён вниз

Первая версия отчёта опиралась на GT, описанный как "экспертный". После аудита это описание пришлось снять:

- для набора из 20 small commits не найден отдельный артефакт с human review или запросом к Claude Opus именно на эти 20 кейсов;
- несколько диапазонов были явно занижены относительно реального diff;
- из-за этого ранний вывод "все модели переоценивают маленькие коммиты в 2-4 раза" был нестабилен уже на уровне датасета.

Вместо этого использован ручной diff-based reassessment в [revised-small-commit-ground-truth.json](C:/Projects/devghost/docs/revised-small-commit-ground-truth.json).

### 2.2 Старый production experiment был не exact replay

Файл `experiment_production_prompts.py` полезен только как prompt-only диагностика, но не как benchmark production pipeline. Аудит показал несколько методологических расхождений:

- туда подтягивался "Ollama baseline" из другого эксперимента с кастомным single-call prompt, а не реальный 2-pass production result;
- experiment прогонял все 20 коммитов через `classify + estimate`, хотя реальный pipeline уводит 5 кейсов в FD path;
- метрики считались по raw pass-2 estimate, а не по финальному `estimated_hours` после correction rules и complexity guard;
- schema и OpenRouter runtime отличались от реального pipeline;
- provider/runtime failures смешивались с model quality.

Из-за этого старый experiment 3 больше нельзя использовать как основной источник выводов про production.

---

## 3. Датасет и GT

Те же 20 коммитов из `Artisan-AI/artisan-private`, но с пересмотренным GT.

| Категория | Кол-во | Файлов |
|-----------|-------:|-------:|
| Small | 8 | 3-7 |
| Medium | 5 | 8-15 |
| Large | 7 | 16-30 |

Новый GT-диапазон: от `0.75-1.5h` до `8-14h`.

Наиболее заметные пересмотры:

| SHA | Было | Стало | Почему исходный GT был слабым |
|-----|-----:|------:|-------------------------------|
| `f4805502` | 0.5-1.5h | 2.5-4.5h | Биллинг-логика в API и temporal worker + 6 тестов |
| `082eaf12` | 0.5-1.5h | 3.0-5.0h | Миграция БД + temporal activity contract + workflow logic |
| `026ac924` | 1.0-2.5h | 3.0-5.0h | Новый auth-protected route + валидация + admin UI |
| `07809e14` | 0.5-1.5h | 2.0-4.0h | Новый blocker flow + integration tests |
| `16b88e6a` | 2.0-5.0h | 5.5-8.5h | Реальная feature work, а не "маленький фиче-коммит" |
| `37ce974c` | 4.0-8.0h | 8.0-14.0h | Крупная reconnect feature с API и integration tests |
| `82e02c56` | 4.0-8.0h | 8.0-13.0h | Большой frontend feature set для CRM property mapping |

Из 20 кейсов только `cba942fb` после аудита остался действительно похожим на sub-2h fix.

---

## 4. Методика

### 4.1 Исторические prompt-only эксперименты

Они сохранены как полезный upper bound для качества prompt-а, но больше не считаются production replay:

- **Эксперимент 1**: Ollama + кастомный single-call prompt, A/B без и с metadata enrichment.
- **Эксперимент 2**: 5 облачных моделей + Ollama на том же кастомном single-call prompt.

### 4.2 True production replay

Для production-части использован новый harness [experiment_production_pipeline_replay.py](C:/Projects/devghost/packages/server/scripts/pipeline/experiment_production_pipeline_replay.py), который:

- вызывает реальный `run_commit()` из `run_v16_pipeline.py`;
- использует production routing: `cascading` для малых diff и `FD` для больших;
- считает итоговый `estimated_hours`, а не промежуточный raw estimate;
- применяет correction rules и complexity guard;
- перезагружает env/config между моделями через `reload_config()`.

### 4.3 Дополнительный diagnostic rerun

Для `GPT-5.1 Codex Mini` и `Qwen3 Flash` сделан отдельный rerun с `--validation-routing`, чтобы отделить provider/runtime проблемы от качества самой модели:

- production runtime: `order=Chutes`, `ignore=Cloudflare`, `require_parameters=True`;
- validation runtime: без provider order/ignore и с `require_parameters=False`.

### 4.4 Метрики

- `MAPE`: ошибка относительно midpoint GT диапазона.
- `Median APE`: медианная относительная ошибка.
- `MAE`: абсолютная ошибка в часах.
- `In-range`: попадание в диапазон `[gt_low, gt_high]`.
- `Bias`: средняя знаковая ошибка.

---

## 5. Результаты

### 5.1 Исторический upper bound: кастомный single-call prompt

Этот блок остаётся полезным как ответ на вопрос "какое качество вообще достижимо на этом наборе, если убрать production pipeline overhead".

**Metadata enrichment** оказался почти нейтральным:

| Метрика | A (baseline) | B (enriched) |
|---------|-------------:|-------------:|
| MAPE | 35.7% | 35.1% |
| In-range | 12/20 | 12/20 |
| MAE | 1.49h | 1.47h |

**Лучшие custom single-call результаты**:

| # | Модель | MAPE | In-range | MAE |
|---|--------|-----:|---------:|----:|
| 1 | Qwen3 Next | 27.1% | 15/20 | 1.14h |
| 2 | Qwen3 Flash | 27.8% | 15/20 | 1.17h |
| 3 | GPT-5.1 Codex Mini | 29.4% | 14/20 | 1.37h |
| 4 | Qwen3 Coder | 29.5% | 12/20 | 1.44h |
| 5 | Ollama (single-call) | 35.7% | 12/20 | 1.49h |

Это важный ориентир: prompt-only режим способен быть заметно лучше реального production pipeline.

### 5.2 Exact production replay

Основной результат этого отчёта — true replay через `run_commit()`.

#### Общий рейтинг

| # | Модель | MAPE | Median APE | MAE | In-range | Bias | FD routed |
|---|--------|-----:|-----------:|----:|---------:|-----:|----------:|
| 1 | Qwen3 Next | 44.8% | 24.4% | 2.96h | 12/20 (60%) | +33.5% | 5/20 |
| 2 | Qwen3 Coder+ | 50.2% | 34.8% | 2.75h | 9/20 (45%) | +49.2% | 5/20 |
| 3 | GPT-5.1 Codex Mini | 57.6%* | 27.2% | 1.99h | 10/20 (50%) | +36.0% | 5/20 |
| 4 | Qwen3 Flash | 57.6%* | 27.2% | 1.99h | 10/20 (50%) | +36.0% | 5/20 |
| 5 | Qwen3 Coder | 71.4% | 68.4% | 3.66h | 6/20 (30%) | +68.7% | 5/20 |
| 6 | Ollama qwen3-coder:30b | 134.8% | 110.3% | 6.62h | 1/20 (5%) | +134.8% | 5/20 |

\* Для GPT-5.1 и Flash это число нельзя читать как "чистое качество модели": в exact production runtime они часто коллапсировали в fallback `5.0h`, и это искусственно улучшало часть попаданий в диапазон.

#### Разбивка по размеру

**Small (3-7 файлов, 8 коммитов):**

| Модель | MAPE | In-range | MAE |
|--------|-----:|---------:|----:|
| Qwen3 Next | 27.4% | 7/8 | 0.52h |
| Qwen3 Coder+ | 54.6% | 4/8 | 1.20h |
| Qwen3 Coder | 61.5% | 4/8 | 1.58h |
| GPT-5.1 Codex Mini* | 108.8% | 2/8 | 2.20h |
| Qwen3 Flash* | 108.8% | 2/8 | 2.20h |
| Ollama qwen3-coder:30b | 115.9% | 0/8 | 3.20h |

**Medium (8-15 файлов, 5 коммитов):**

| Модель | MAPE | In-range | MAE |
|--------|-----:|---------:|----:|
| GPT-5.1 Codex Mini* | 17.7% | 4/5 | 0.90h |
| Qwen3 Flash* | 17.7% | 4/5 | 0.90h |
| Qwen3 Next | 21.1% | 4/5 | 1.00h |
| Qwen3 Coder+ | 24.4% | 3/5 | 1.10h |
| Qwen3 Coder | 82.3% | 1/5 | 3.80h |
| Ollama qwen3-coder:30b | 180.1% | 0/5 | 9.40h |

**Large (16-30 файлов, 7 коммитов):**

| Модель | MAPE | In-range | MAE |
|--------|-----:|---------:|----:|
| GPT-5.1 Codex Mini* | 27.7% | 4/7 | 2.54h |
| Qwen3 Flash* | 27.7% | 4/7 | 2.54h |
| Qwen3 Coder+ | 63.6% | 2/7 | 5.69h |
| Qwen3 Coder | 75.1% | 1/7 | 5.95h |
| Qwen3 Next | 81.5% | 1/7 | 7.16h |
| Ollama qwen3-coder:30b | 124.1% | 1/7 | 8.54h |

Здесь ключевой момент: exact replay показывает не только prompt problem, но и реальную слабость текущего pipeline поведения, особенно у локальной Ollama и у `qwen/qwen3-coder`.

### 5.3 Diagnostic rerun для GPT-5.1 и Flash

Когда provider restrictions были сняты (`--validation-routing`), стало видно, что exact production результаты для этих двух моделей были частично артефактом fallback `5h`.

| Модель | Exact production replay | Validation-routing rerun | Что это значит |
|--------|------------------------:|-------------------------:|----------------|
| GPT-5.1 Codex Mini | 57.6% MAPE, 10/20 in-range | 76.4% MAPE, 6/20 in-range | Exact runtime был искусственно "улучшен" fallback-ами |
| Qwen3 Flash | 57.6% MAPE, 10/20 in-range | 94.4% MAPE, 2/20 in-range | Та же проблема, но ещё сильнее |

Вывод: GPT/Flash нельзя интерпретировать по exact replay как сильные production-модели на этом наборе. Их качество в real production runtime смешано с provider/runtime failure behavior.

### 5.4 Custom prompt vs exact production

После true replay видно, что старый prompt-only rerun недооценивал разрыв между "качество prompt-а" и "качество реального pipeline".

| Модель | Custom single-call | Exact production replay | Дельта |
|--------|-------------------:|------------------------:|-------:|
| Qwen3 Next | 27.1% | 44.8% | +17.7pp |
| Qwen3 Coder | 29.5% | 71.4% | +41.9pp |
| Ollama qwen3-coder:30b | 35.7% | 134.8% | +99.1pp |

Это, пожалуй, самый важный практический результат всего исследования:

- prompt-only benchmark не равен production quality;
- большая часть production-tax сидит не только в system prompt, но и в routing, classify behavior, FD crossover, correction rules и runtime/provider constraints;
- для локальной Ollama real production pipeline на этом наборе оказался провальным.

---

## 6. Выводы

### 6.1 Что теперь можно утверждать уверенно

1. **GT в первой версии был смещён вниз.** Это был первый и главный methodological bug.
2. **Metadata enrichment не является главным рычагом.** На custom single-call режиме он почти ничего не меняет.
3. **Production pipeline действительно заметно хуже custom single-call baseline.** После exact replay это уже подтверждено напрямую, а не через упрощённый harness.
4. **Локальная Ollama не должна считаться приемлемым production baseline на этом наборе.** True replay дал `134.8% MAPE` и только `1/20` попаданий в диапазон.
5. **Лучший exact production результат среди стабильных прогонов — Qwen3 Next.** Но даже он заметно хуже своего custom single-call варианта.

### 6.2 Что больше нельзя утверждать

- нельзя ссылаться на старый `experiment_production_prompts.py` как на "точную реплику пайплайна";
- нельзя использовать exact production метрики GPT/Flash без оговорки про fallback/runtime artifact;
- нельзя говорить "модель менять не нужно";
- нельзя вводить hard cap вроде `small_commit_cap=3h` до окончательной стабилизации GT.

### 6.3 Корневая проблема

После всех пересмотров картина выглядит так:

- **GT bias** объяснял большую часть раннего "катастрофического" overestimation;
- **prompt calibration** всё ещё важен;
- но **главный production gap** — это уже не только prompt. Это сумма prompt-а, classify routing, перехода в FD на части кейсов, correction rules и provider/runtime поведения.

---

## 7. Рекомендации

### Приоритет 1 — benchmark только через true replay

- считать [experiment_production_pipeline_replay.py](C:/Projects/devghost/packages/server/scripts/pipeline/experiment_production_pipeline_replay.py) основным harness для production accuracy;
- старый `experiment_production_prompts.py` оставить как исторический prompt-ablation script, но не использовать для итоговых ranking/decision claims.

### Приоритет 2 — сменить production baseline

- не использовать локальную `qwen3-coder:30b` как ориентир для качества на small/normal commits;
- если выбирать из уже проверенного exact replay, лучшая production-кандидатура сейчас — `qwen/qwen3-coder-next`.

### Приоритет 3 — отдельно лечить runtime compatibility

- GPT-5.1 Codex Mini и Qwen3 Flash надо оценивать в двух измерениях: `model quality` и `provider/runtime compatibility`;
- exact production runtime показал, что часть pipeline-результатов может быть просто fallback artifact.

### Приоритет 4 — продолжить работу с prompt/routing, но не маскировать проблему caps

- улучшать `PROMPT_2PASS_V2` и classify behavior;
- отдельно проверить, почему часть кейсов уходит в `module`/`none` так, как уходит сейчас;
- не добавлять жёсткие caps для small commits до завершения GT stabilization и следующего replay.

### Приоритет 5 — оптимизировать small path вокруг Qwen3 Next

- follow-up аудит и live optimization replay зафиксированы в отдельном документе [research-small-commit-qwen-next-optimization.md](C:/Projects/devghost/docs/research-small-commit-qwen-next-optimization.md);
- главный вывод этого follow-up: первым production fix должен быть не новый prompt, а прокидывание реального `contextLength` модели в normal analysis path;
- на revised 20-case GT это изменение улучшает `Qwen3 Next` с `44.8%` до `27.7% MAPE` без переписывания всей архитектуры.

---

## 8. Артефакты

| Файл | Описание |
|------|----------|
| [revised-small-commit-ground-truth.json](C:/Projects/devghost/docs/revised-small-commit-ground-truth.json) | Пересмотренный GT для 20 коммитов |
| [research-small-commit-estimation-quality-rerun.md](C:/Projects/devghost/docs/research-small-commit-estimation-quality-rerun.md) | Исторический rerun старых prompt-only результатов на новом GT |
| [research-small-commit-estimation-quality-rerun.json](C:/Projects/devghost/docs/research-small-commit-estimation-quality-rerun.json) | Машиночитаемый prompt-only rerun |
| [experiment_production_pipeline_replay.py](C:/Projects/devghost/packages/server/scripts/pipeline/experiment_production_pipeline_replay.py) | Новый exact replay harness поверх `run_commit()` |
| [experiment_small_commit_optimization.py](C:/Projects/devghost/packages/server/scripts/pipeline/experiment_small_commit_optimization.py) | Follow-up harness для оптимизации small path под `Qwen3 Next` |
| [production_pipeline_replay_2026-03-27_220924.md](C:/Projects/devghost/packages/server/scripts/pipeline/experiment_v3_results/production_pipeline_replay_2026-03-27_220924.md) | Exact production replay на 6 моделях |
| [production_pipeline_replay_2026-03-27_220924.json](C:/Projects/devghost/packages/server/scripts/pipeline/experiment_v3_results/production_pipeline_replay_2026-03-27_220924.json) | Машиночитаемый exact replay |
| [production_pipeline_replay_2026-03-27_221640.md](C:/Projects/devghost/packages/server/scripts/pipeline/experiment_v3_results/production_pipeline_replay_2026-03-27_221640.md) | Diagnostic rerun для GPT/Flash с validation routing |
| [production_pipeline_replay_2026-03-27_221640.json](C:/Projects/devghost/packages/server/scripts/pipeline/experiment_v3_results/production_pipeline_replay_2026-03-27_221640.json) | Машиночитаемый diagnostic rerun |
| [small_commit_optimization_2026-03-28_001553.md](C:/Projects/devghost/packages/server/scripts/pipeline/experiment_v3_results/small_commit_optimization_2026-03-28_001553.md) | Live optimization replay для `Qwen3 Next` с реальным context length |
| [small_commit_optimization_2026-03-28_001553.json](C:/Projects/devghost/packages/server/scripts/pipeline/experiment_v3_results/small_commit_optimization_2026-03-28_001553.json) | Машиночитаемый optimization replay |
| [research-small-commit-qwen-next-optimization.md](C:/Projects/devghost/docs/research-small-commit-qwen-next-optimization.md) | Итоговый план оптимизации small path перед демо |

Этот отчёт надо считать актуальной версией исследования. Предыдущая интерпретация production prompts сохранена только как исторический intermediate result.
