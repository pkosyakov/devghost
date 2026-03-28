# Expert Review: Cluster-Based FD Architecture

**Date**: 2026-03-25
**Context**: Экспертный анализ fix-fd-overestimation-design.md и audit-bulk-commit-639h.md
**Status**: Получено, проанализировано. Принято как направление для FD v2.

## Ключевой тезис эксперта

Per-file FD с суммированием (`effort = Σ effort(file_i)`) — принципиально неправильная модель для крупных коммитов. Hard cap — костыль, который скрывает симптом, но не лечит болезнь.

Три причины поломки per-file sum:
1. **Shared architectural context** — инженер, написавший `call-task.service`, написал `DialerSettingsModal` в 10x быстрее, потому что контекст уже в голове. LLM этого не видит.
2. **Superlinear estimation bias** — LLM калиброван на «средний изолированный файл» и ставит 1-2h. Умноженное на 300 файлов = 300-600h. Ошибка агрегации, не LLM.
3. **LLM не видит дифф соседей** — `compliance.service.ts` оценивается в 2h, но LLM не знает, что `twilio-requirements.json` (1091 строка) уже учтён, а сервис — просто маппинг этих данных.

## Предложенная архитектура: Semantic Clustering

### Шаг 1: Группировка файлов в смысловые блоки

Сигналы для кластеризации:
- Общий каталог (`/dialer/`, `/compliance/`, `/auth/`)
- Именной паттерн (`*.service`, `*.repository`, `*.controller` — один вертикальный срез)
- Import graph (файлы, импортирующие друг друга)
- Общий префикс изменений в commit message

Пример: 272 файла Feat/dialer v1 → ~8-12 кластеров:
- `twilio-core` (3 файла, ~1500 строк реальной логики)
- `compliance-service` (2 файла, ~1000 строк)
- `dialer-ui` (30 TSX файлов, но один компонент)
- `generated/data` (bun.lock, requirements.json — 0h)
- `tests` (отдельный кластер с discount)

### Шаг 2: LLM оценивает кластер, а не файл

```
Cluster: "telephony-core" (3 files, 2600 lines)
Files: call-task.service.ts (1075L), compliance.service.ts (994L), twilio-requirements.json (1091L)
Context: Part of a Twilio dialer integration (commit total: 272 files).
This cluster implements [X]. Estimate effort for THIS cluster only.
```

LLM видит контекст «часть большей системы» и оценивает кластер как единицу.

### Шаг 3: Агрегация с cross-cluster discount

```python
cluster_count = len(clusters)
discount = 1.0 - min(0.4, (cluster_count - 1) * 0.04)
# 1 кластер → 0% discount
# 5 кластеров → 16% discount
# 10 кластеров → 36% discount
# 11+ → max 40% discount
total = sum(cluster_estimates) * discount
```

### Шаг 4: Commit-level sanity check

Один LLM-вызов на весь коммит после cluster estimates. Если расхождение >2x — использовать `min(cluster_sum, commit_level * 1.5)`.

## Расширенная таксономия коммитов

| Тип | Признаки | Модель оценки | Bounds |
|-----|----------|---------------|--------|
| Scaffold/copy | >80% new, scaffold keyword ИЛИ >95% new | Формула: base + per-file coefficient | 4-40h |
| Vertical feature | >60% new, feature keyword, кластеры по домену | Cluster-based + cross-cluster discount | 8-80h |
| Horizontal refactor | >60% existing files, повторяющийся паттерн | Bulk pattern: N файлов × типовое время | 4-40h |
| Tooling migration | <30% new, lockfiles, конфиги | Mechanical + агрессивная фильтрация | 2-20h |
| Breaking change | migration files + API changes + test rewrites | Architectural estimate + complexity multiplier | 16-120h |

## Наш анализ экспертного мнения

### Что подтверждено исследованиями (Tavily search)

| Тезис | Подтверждение |
|-------|---------------|
| Файлы не независимы, shared context снижает усилия | Cohesion theory, change coupling research (IME-USP, CodeScene), Frontiers in AI 2026 framework |
| Per-file aggregation переоценивает | REARRANGE paper (Monash, 2024): MAE 5.47h при cluster-level vs 453h при file-level. Atomic Object: "summing high estimates gives very large estimate" |
| LLM может оценивать на уровне кластеров | CodeChain (ICLR 2024), OmniLLP (2025, arXiv), CMU 2025 thesis on LLM task decomposition |
| Оптимальная гранулярность — не per-file | CMU: >12 subtasks деградирует качество. Sweet spot 2-8 файлов/кластер |

### Что НЕ подтверждено (требует калибровки)

1. **Cross-cluster discount формула** — коэффициент `0.04 per cluster, max 40%` не имеет эмпирического обоснования. Ни одно исследование не даёт конкретного числа. Нужна калибровка на наших GroundTruth данных (таблица GroundTruth в БД содержит экспертные оценки).

2. **Tooling migration detector** — порог `lockfile_ratio + config_ratio > 0.6` произвольный. Commit #6 (pnpm/vitest) имеет 7% new files — его можно ловить дешевле через existing signals (low new_file_ratio + high file_count + lockfile presence).

3. **TYPE_BOUNDS** — конкретные диапазоны (4-40h, 8-80h, etc.) не обоснованы данными. Требуют валидации на полном наборе GroundTruth перед использованием в production.

4. **"Убрать hard cap"** — преждевременно. Cap нужен как safety net пока cluster-based FD не стабилизирован. TYPE_BOUNDS — правильная замена, но только после валидации.

### Практический вывод

Эксперт предлагает правильную архитектуру — это **не hotfix текущей проблемы, а следующая итерация пайплайна (FD v2)**.

Текущий фикс (scaffold detector + force_complex guard + enriched prompt + hard cap 80h) — валидный first step:
- Scaffold коммиты: 639.8h → 30.5h (проверено)
- Feature коммиты: 127-280h → <=80h (cap, проверено)
- Общее снижение top-11: -70% (2238.7h → ~679h)

Cluster-based FD — следующий шаг, который решит оставшийся gap (80h cap vs GT 15-60h для feature коммитов).

### Рекомендуемый порядок реализации

1. **Сейчас**: мержить текущий фикс (scaffold + guard + cap) — уже даёт значительное улучшение
2. **Затем**: собрать GroundTruth для калибровки (запрос отправлен руководителю разработки)
3. **FD v2**: реализовать semantic clustering (начать с простой кластеризации по dir depth-1)
4. **FD v2.1**: добавить cross-cluster discount (калиброванный на GroundTruth)
5. **FD v2.2**: commit-level sanity check, TYPE_BOUNDS, убрать hard cap

## Ссылки из исследования

- REARRANGE (2024, Monash University, Information and Software Technology) — cluster-level estimation MAE 5.47h vs 453h file-level
- CodeChain (ICLR 2024) — LLM modular decomposition
- OmniLLP (2025, arXiv) — UMAP + HDBSCAN on code embeddings, local models per cluster
- CMU 2025 thesis — LLM task decomposition, optimal subtask count
- Frontiers in AI (2026) — "Toward LLM-aware software effort estimation" framework
- Jorgensen (2014, InfoQ survey) — economies of scale in small components
