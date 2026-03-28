# Исследование холистической оценки трудозатрат (FD v3)

**Дата**: 2026-03-27
**Автор**: Enigma (Hands)
**Статус**: Завершено

---

## 1. Цель

Валидировать подход FD v3 — замену текущей архитектуры FD v2 (per-cluster LLM + holistic + combine) на **один вызов LLM с богатыми структурированными метаданными** (без отправки diff кода) для оценки трудозатрат на больших коммитах (50+ файлов).

### 1.1 Проблема

FD v2 систематически переоценивает большие коммиты в 2-10x. Валидация на 5 GT-коммитах (claude-sonnet-4) показала:

| Коммит | Branch B (cluster) | Holistic | Итог (v2) | GT |
|--------|------------------:|--------:|---------:|----:|
| dialer (272 files) | 456.7h | 85.0h | 88.7h | 40-60h |
| vitest (1036 files) | 43.5h | 8.5h | 30.2h | 8-16h |
| visitors (159 files) | 231.2h | 45.2h | 53.6h | 25-40h |
| temporal (123 files) | 156.4h | 28.5h | 49.2h | 20-35h |
| chat (105 files) | 128.2h | 28.5h | 34.8h | 15-25h |

**Ключевой инсайт**: Холистический компонент (метаданные, без кода) — уже самая точная часть v2. Остальные компоненты только ухудшают результат:
- Branch B (per-cluster LLM) переоценивает 3-10x: каждый кластер оценивается в изоляции, теряя контекст целого коммита
- `heuristic_total` добавляется поверх LLM-оценки, создавая двойной учёт
- `combine_estimates()` усредняет сломанный Branch B с хорошим holistic

### 1.2 Гипотеза

Один вызов LLM с обогащёнными метаданными (entropy, паттерны, файловые тиры, кластеры) и калибровочными якорями даст MAPE <50% на больших коммитах, при этом стоимость снизится с ~$0.30-0.80 до ~$0.01-0.03 за коммит (1 вызов вместо 16-31).

---

## 2. Методика

### 2.1 Датасет

**Эксперимент 1** — 10 крупных коммитов из Artisan-AI/artisan-private (107-1036 файлов) с internal GT-оценками из `ground-truth-request.md`, позже просмотренными экспертом. По post-hoc sanity check эксперт подтвердил, что диапазоны в целом релевантны; возможное систематическое занижение оценивается примерно в 10-20%, но не меняет ranking моделей.

| # | Коммит | Описание | Файлов | GT |
|---|--------|----------|-------:|---:|
| 1 | 188c43e | Refactor/monorepo (#597) | 870 | 15-30h |
| 2 | 1d02576 | Feat/dialer v1 (#968) | 272 | 40-60h |
| 3 | 0237e3a | Feat/workos auth (#751) | 388 | 30-50h |
| 4 | 47252d6 | Feat/magic campaigns (#842) | 391 | 40-60h |
| 5 | 4ccdf71 | Feat/leads lists (#1297) | 265 | 30-50h |
| 6 | 16dc74e | Feat/pnpm vitest migration (#974) | 1036 | 8-16h |
| 7 | 9c2a0ed | Feat/web visitors (#1048) | 159 | 25-40h |
| 8 | b4bb3f0 | Adhoc: leadsdb rework (#782) | 145 | 20-35h |
| 9 | 18156d0 | Temporal scheduler (#939) | 123 | 20-35h |
| 10 | c8269d0 | UI library setup | 107 | 4-8h |

Выборка включает разные типы: реальные фичи, миграции, рефакторинг, scaffolding, protobuf-переработка.

**Эксперимент 2** — 55 обычных коммитов (3-30 файлов) для проверки применимости metadata-only подхода к маленьким коммитам. Важно: для этого набора использовался provisional GT, полученный эвристически по метаданным, а не отдельный экспертный review, поэтому этот эксперимент следует трактовать как исторический stress test, а не как финальный benchmark.

### 2.2 Модели

**Эксперимент 1 — 5 моделей через OpenRouter:**

| Сокращение | Полное имя | Тип |
|------------|-----------|-----|
| opus | anthropic/claude-opus-4.6 | Premium |
| sonnet | anthropic/claude-sonnet-4.6 | Standard |
| haiku | anthropic/claude-haiku-4.5 | Fast |
| qwen | qwen/qwen3-coder-plus | Coder |
| gpt | openai/gpt-5.3-codex | OpenAI |

**Эксперимент 2 — Ollama (локальный):**

| Модель | Параметры |
|--------|-----------|
| qwen3-coder:30b | num_ctx=32768, temp=0, seed=42 |

### 2.3 Подход v3: метаданные вместо кода

Ключевое отличие v3 от традиционного подхода — LLM **не видит код**. Вместо diff отправляется структурированный блок метаданных:

```
## COMMIT
SHA: 188c43e
Message: Refactor/monorepo (#597)

## LANGUAGE
Primary: TypeScript

## CHANGE VOLUME
Total files: 870  (+101234 / -1456 lines)
New-file ratio: 95% of files are add-only
Module boundaries touched: 4 (apps, libs, web, api)

## FILE TYPE BREAKDOWN
SKIP (generated/lock/locale): 139 files — 0h
HEURISTIC (docs/config/tests): 91 files — ~12.3h by formula
LLM-required (substantive code): 731 files — needs judgment
Effective churn (LLM files only): +71234 / -892 lines

## DISTRIBUTION
Change entropy: 8.21 bits (extremely_high)
File size (lines changed) — p50: 58, p90: 215, max: 4699

## EXTENSIONS (LLM files, top 5)
  .tsx: 412 files
  .ts: 289 files
  .json: 18 files
  .css: 9 files
  .go: 3 files

## PATTERN FLAGS
  SCAFFOLD (>95%): >95% new files, treat as copy/scaffold
  BULK_REFACTOR: ratio=16%
  142 files with near-identical edits (batch find-replace style)

## STRUCTURE
  libs/ui: 312 files (+42000/-200)
  web/components: 198 files (+28000/-400)
  apps/api: 45 files (+3200/-180)
  ...

Estimate effort for this commit:
```

**V3 метаданные включают:**

| Категория | Фичи | Источник |
|-----------|-------|---------|
| Объём | fc, la, ld, new_file_ratio | git diff --stat |
| Классификация | SKIP/HEURISTIC/LLM файлы, heuristic_total | classify_file_tier() |
| Распределение | Shannon entropy, file size p50/p90/max | Вычисляется из diff |
| Эффективный churn | la/ld только по LLM-файлам | adaptive_filter() |
| Модульность | Кол-во модулей, список top-level dirs | git paths |
| Паттерны | MOVE, BULK_REFACTOR, SCAFFOLD, HIGH_GENERATED | classify_move_commit(), detect_bulk_refactoring() |
| Структура | Кластеры файлов (name, count, la/ld) | build_clusters() |
| Язык | Основной + дополнительные | Расширения файлов |

### 2.4 Калибровочные якоря (system prompt)

```
You are an expert software engineer estimating commit effort for a mid-level developer
(3-4 years experience, familiar with the codebase, working without AI assistance).

## CALIBRATION
- Manual code: 50-100 lines/hour
- Auto-generated code: 0 hours (zero effort)
- File rename/move (per 50 files): 0.5h
- Tests: 50-75% of equivalent production code effort
- Config changes: 0.1-0.5 each
- Docs: 0.3h per 100 lines
- Bulk find-replace/refactor: 2-4h total (not per file)

## ANTI-OVERESTIMATION
- SKIP files: generated, lock files, snapshots, locale files = 0h
- Rename-only commits: effort is coordination overhead, NOT rewriting code
- Bulk systematic edits (same pattern N files): count as 1 task, not N
- Scaffold/copy commits: base setup time only, not full feature time
- Tests that mirror implementation: 50-75% of production code effort, not 100%
- Config files: quick edits; only complex new configs take >0.5h
```

### 2.5 Формат ответа

JSON-схема: `{ low, mid, high, confidence, reasoning }` — три оценки (диапазон), уровень уверенности и 2-3 предложения reasoning.

### 2.6 Метрики

- **MAPE** — Mean Absolute Percentage Error (относительно midpoint GT диапазона)
- **MdAPE** — Median APE
- **In-range** — попадание mid-оценки в GT диапазон [gt_low, gt_high]
- **Within 2x** — оценка в пределах 2x от GT диапазона
- **Bias** — средняя знаковая ошибка (>0 = переоценка, <0 = недооценка)
- **O/U** — количество пере/недооценок

---

## 3. Результаты

### 3.1 Эксперимент 1 — 5 моделей на 10 крупных коммитах

#### Общий рейтинг

| # | Модель | MAPE | MdAPE | In-Range | Within 2x | Bias | O/U |
|---|--------|-----:|------:|--------:|---------:|-----:|----:|
| 1 | **opus** | **26.0%** | 20.0% | **6/10** | **10/10** | +7.0h | 7O/2U |
| 2 | **qwen (Coder+)** | **32.1%** | 25.2% | **6/10** | **10/10** | -1.9h | 4O/5U |
| — | *baseline (heuristic)* | *68.6%* | *—* | *2/10* | *—* | *—* | *—* |
| 3 | sonnet | 80.2% | 46.2% | 4/10 | 8/10 | +30.1h | 8O/1U |
| 4 | haiku | 131.7% | 103.9% | 2/10 | 7/10 | +40.4h | 10O/0U |
| 5 | gpt | 170.0% | 170.0% | 0/5 | 2/5 | +57.8h | 5O/0U |

> Opus и Qwen3 Coder+ значительно опередили baseline heuristic (68.6%) и все остальные модели. GPT-5.3 Codex фейлил на 5 из 10 коммитов.

> Чувствительность к GT: если сдвинуть все GT-диапазоны вверх на 10-20% (в соответствии с поздним экспертным sanity check), `Opus` улучшается до `21.4% -> 19.2% MAPE`, `Qwen3 Coder+` остаётся в диапазоне `31.0% -> 32.8%`, а ranking моделей не меняется.

#### Per-commit результаты

| Коммит | GT | opus | sonnet | haiku | qwen | gpt |
|--------|---:|-----:|------:|-----:|----:|----:|
| 188c43e monorepo (870f) | 15-30h | **18h** | **16h** | 56h | **25h** | ERR |
| 1d02576 dialer (272f) | 40-60h | 80h | 180h | 180h | 75h | 185h |
| 0237e3a workos (388f) | 30-50h | **48h** | 65h | **48h** | **25h** | ERR |
| 47252d6 campaigns (391f) | 40-60h | **48h** | 65h | 180h | **25h** | 105h |
| 4ccdf71 leads (265f) | 30-50h | **45h** | 90h | **48h** | **45h** | 108h |
| 16dc74e vitest (1036f) | 8-16h | 18h | **14h** | 48h | **12h** | 38h |
| 9c2a0ed visitors (159f) | 25-40h | 45h | 90h | 48h | **25h** | ERR |
| b4bb3f0 leadsdb (145f) | 20-35h | **28h** | **28h** | 42h | **20h** | ERR |
| 18156d0 temporal (123f) | 20-35h | 42h | 55h | 48h | **25h** | ERR |
| c8269d0 ui-lib (107f) | 4-8h | **6h** | **6h** | 14h | 12h | 11h |

**Жирным** выделены оценки, попавшие в GT диапазон.

#### Характеристики моделей

**Opus** (MAPE 26%): Отличное reasoning — корректно распознаёт scaffold, bulk-refactor и move-паттерны. Небольшая переоценка (bias +7h) в основном из-за dialer (80h vs GT 40-60h). Наиболее стабильная модель: все 10 коммитов в пределах 2x.

**Qwen3 Coder+** (MAPE 32%): Наименьший bias (-1.9h, почти нейтральный). Высокая уверенность в оценках (`confidence: high` на 9/10). Единственная модель, склонная к лёгкой недооценке (4O/5U). Не фейлила ни на одном коммите.

**Sonnet** (MAPE 80%): Умеренная переоценка. Хороший на scaffold-коммитах (ui-lib 6h, vitest 14h), но переоценивает реальные фичи (dialer 180h, visitors 90h).

**Haiku** (MAPE 132%): Стабильно выдаёт 48h как "дефолтную" оценку (4 из 10 коммитов = 48h). Не различает 8h и 40h коммиты. Переоценка 10/10.

**GPT-5.3 Codex** (MAPE 170%): 5 из 10 запросов ERROR (проблемы с API/форматом). Из 5 успешных — все переоценены. Наихудший результат.

### 3.2 Эксперимент 2 — Metadata-only на маленьких коммитах (historical diagnostic)

Проверка на provisional GT: работает ли metadata-only подход для обычных коммитов (3-30 файлов)?

| Подход | MAPE | MdAPE | In-Range | Bias | O/U |
|--------|-----:|------:|--------:|-----:|----:|
| **V3 holistic (Ollama)** | 127.0% | 100.0% | 14/55 (25%) | +2.6h | 54O/0U |
| Heuristic only | 92.2% | 97.0% | 0/55 (0%) | -2.6h | 0O/55U |

#### Разбивка по размеру

**Маленькие коммиты (3-7 файлов):**
- V3 MAPE: ~250-350% (модель не может оценить ниже 2h, при GT 0.3-1.5h)
- Heuristic: 80-100% (но всегда 0h, не попадает в диапазон)

**Средние коммиты (8-15 файлов):**
- V3 MAPE: ~80-130% (приемлемо, но с систематической переоценкой)

**Большие коммиты (16-30 файлов):**
- V3 MAPE: ~50-70% (хорошие результаты, 10/14 в пределах 2x)

#### Вердикт

**Исторический stress test показывает, что metadata-only, вероятно, плохо подходит для маленьких коммитов.** Без кода diff модель действительно не различает тривиальный фикс от существенного изменения при похожем количестве файлов, но этот вывод имеет более низкую уверенность, чем large-commit часть исследования, потому что GT для 55 кейсов был provisional. Для практических решений по small/normal commits следует опираться на отдельное diff-based исследование.

### 3.3 Сравнение v3 с историческим baseline v2

Это не apples-to-apples benchmark: `v3` измерялся на текущем наборе из 10 крупных коммитов, а `v2` baseline ниже взят из более ранней 5-коммитной валидации из design document.

| Подход | MAPE | In-range | Стоимость/коммит | LLM-вызовов |
|--------|-----:|--------:|--------:|------:|
| **v3 (opus)** | **26.0%** | **6/10** | ~$0.05 | 1 |
| **v3 (qwen)** | **32.1%** | **6/10** | ~$0.01 | 1 |
| v2 (sonnet, historical baseline) | ~80%* | ~2/5* | ~$0.30-0.80 | 16-31 |
| Heuristic only | 68.6% | 2/10 | $0 | 0 |

*Данные v2 по 5 коммитам из design document, поэтому сравнение directional, а не строго парное.

Направление улучшения: `v3` выглядит существенно точнее и дешевле исторического `v2` baseline, но для полностью парного сравнения нужен отдельный replay `v2` на этом же 10-case large-commit наборе.

---

## 4. Анализ reasoning моделей

### 4.1 Что модели-лидеры делают правильно

**Распознавание scaffold/copy паттернов:**
> Opus (188c43e, 870 files): "The 95% new-file ratio with 870 files and ~100k added lines strongly suggests code was moved/reorganized rather than written from scratch." → 18h (**OK**, GT 15-30h)

**Дисконтирование bulk-refactor:**
> Qwen (16dc74e, 1036 files): "This is a pnpm/vitest migration affecting 1036 files with 79% bulk refactor ratio — most files are systematic package manager and test runner configuration changes. Only 219 files have unique substantive changes." → 12h (**OK**, GT 8-16h)

**Учёт модульной координации:**
> Opus (4ccdf71, 265 files): "After discounting ~64 bulk/systematic edit files and generated files, roughly 200 files have substantive changes with ~14k effective lines added... significant integration complexity." → 45h (**OK**, GT 30-50h)

### 4.2 Типичные ошибки слабых моделей

**Haiku — "дефолтная" оценка 48h:**
Haiku выдаёт 48h на 4 из 10 коммитов, включая как vitest-миграцию (GT 8-16h), так и leads-lists (GT 30-50h). Модель не различает масштаб.

**GPT — накручивание "integration effort":**
> GPT (47252d6, 391 files): "A mid-level developer familiar with the codebase would likely spend multiple weeks implementing, validating, and stabilizing this end-to-end slice." → 105h (GT 40-60h, APE 110%)

**Sonnet — переоценка реальных фич:**
> Sonnet (1d02576, dialer): "At 50-100 lines/hour for production code... this represents a multi-week feature build." → 180h (GT 40-60h, APE 260%)

---

## 5. Выводы

### 5.1 Проверка гипотезы

| Утверждение | Результат | Обоснование |
|-------------|-----------|------------|
| v3 metadata-only для крупных коммитов (50+ файлов) даёт MAPE <50% | **Подтверждено** | Opus 26%, Qwen 32% — оба ниже целевых 50% |
| v3 заменяет v2 для крупных коммитов | **Подтверждено как прод-направление** | v3 уверенно сильнее heuristic и существенно лучше исторического v2 baseline; прямой парный replay `v2 vs v3` на одинаковом 10-case наборе пока не проведён |
| v3 metadata-only работает для маленьких коммитов | **Предварительно не подтверждено** | Historical diagnostic на provisional 55-case GT дал 127% MAPE; сигнал негативный, но ниже по уровню доказательности |

### 5.2 Выбор модели для продакшена

| Критерий | Opus | Qwen3 Coder+ |
|----------|------|-------------|
| MAPE | 26.0% | 32.1% |
| In-range | 6/10 | 6/10 |
| Within 2x | 10/10 | 10/10 |
| Bias | +7.0h (переоценка) | -1.9h (нейтральный) |
| Надёжность | 10/10 успехов | 10/10 успехов |
| Стоимость | ~$0.05/коммит | ~$0.01/коммит |
| Latency | ~8s | ~4.4s |

**Рекомендация**: Qwen3 Coder+ как модель по умолчанию для pilot/production `v3` на крупных коммитах (5x дешевле, быстрее, нейтральный bias). Opus — для enterprise tier или как fallback при высокой неопределённости.

### 5.3 Границы применимости

- **v3 holistic**: коммиты 50+ файлов (замена FD v2)
- **Текущий пайплайн (diff-based)**: коммиты 3-49 файлов (FD v2 + промпт с калибровочными якорями)
- **Metadata-only пока не рекомендуется**: для коммитов <50 файлов. Исторический stress test плохой, а для надёжного решения нужен diff-based path и отдельная revalidation на качественном GT

### 5.4 Единственное изменение в продакшене

По итогам всех исследований (текущее + [исследование маленьких коммитов](research-small-commit-estimation-quality.md)):

**Заменить FD v2 на v3 holistic для крупных коммитов (50+ файлов)**:
- В `file_decomposition.py`: при `fc >= 50` — один вызов LLM с metadata-only промптом вместо Branch B + holistic + combine
- Модель: Qwen3 Coder+ через OpenRouter (или Opus для enterprise)
- System prompt с калибровочными якорями (Section 2.4)
- Structured output: `{ low, mid, high, confidence, reasoning }`

---

## 6. Артефакты

| Файл | Описание |
|------|----------|
| `ground-truth-request.md` | Источник internal GT-диапазонов для 10 крупных коммитов |
| `experiment_v3.py` | Скрипт эксперимента 1 (5 моделей x 10 крупных коммитов) |
| `experiment_v3_ollama.py` | Скрипт эксперимента 2 (Ollama x 55 обычных коммитов) |
| `experiment_v3_results/experiment_v3_*.json` | Результаты эксперимента 1 |
| `experiment_v3_results/experiment_v3_ollama_*.json` | Результаты эксперимента 2 |
| `fd-v3-holistic-estimation-design.md` | Design document (EN) |
| `fd-v3-holistic-estimation-design-ru.md` | Design document (RU) |

Все скрипты расположены в `packages/server/scripts/pipeline/`.
