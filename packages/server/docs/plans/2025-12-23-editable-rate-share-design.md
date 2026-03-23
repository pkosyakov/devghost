# Editable Rate & Share Feature Design

## Overview

Add editable "Daily Rate" and "Share" (Доля) fields per developer in the metrics table, with real-time recalculation and persistence per Order.

## Requirements

1. **Editable Fields**: Daily Rate and Share columns with inline editing
2. **Real-time Recalculation**: Effective Rate, Deviation, and Total Cost update instantly
3. **Persistence**: Settings saved to database per Order
4. **Reset**: Single button to restore all developers to default values
5. **Bug Fix**: Correct inverted effRate formula in demo page

## Database Schema

```prisma
model DeveloperSettings {
  id             String   @id @default(cuid())
  orderId        String
  developerEmail String
  dailyRate      Int      @default(500)
  share          Decimal  @default(1.0) @db.Decimal(3, 2)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  order          Order    @relation(fields: [orderId], references: [id], onDelete: Cascade)

  @@unique([orderId, developerEmail])
}
```

## API Endpoints

### GET /api/orders/[id]/developer-settings
Returns all developer settings for an order.

### PATCH /api/orders/[id]/developer-settings
Updates settings for one or more developers.
```json
{
  "settings": [
    { "developerEmail": "dev@example.com", "dailyRate": 600, "share": 0.8 }
  ]
}
```

### POST /api/orders/[id]/developer-settings/reset
Resets all developers to default values (rate=500, share=1.0).

## UI Changes

### Metrics Table Columns

Current: Developer | Commits | Work Days | Productivity | Daily Rate | Eff. Rate | Deviation | Total Cost

New: Developer | Commits | Work Days | Productivity | **Share** | Daily Rate | Eff. Rate | Deviation | Total Cost

### Inline Editing Behavior

1. Click on Share or Daily Rate cell → transforms to input
2. Enter/Tab/blur → save and recalculate
3. Escape → cancel edit
4. Visual indicator for modified values (different background)

### Reset Button

- Location: Table header, next to "Developer Metrics" title
- Icon: RotateCcw (lucide)
- Tooltip: "Reset all rates and shares to defaults"
- Confirmation: None (instant action, easily reversible)

## Calculation Formulas

```typescript
// With share parameter:
const effRate = (avgDailyEffort / (STANDARD_DAILY_EFFORT * share)) * dailyRate;
const deviation = ((effRate - dailyRate) / dailyRate) * 100;
const totalCost = effRate * workDays;
```

Example with share = 0.5 (50%):
- avgDailyEffort = 3.8h, dailyRate = 500
- effRate = (3.8 / (3.8 * 0.5)) * 500 = (3.8 / 1.9) * 500 = 1000
- Developer working half-time but producing full output = 2x effective rate

## Demo Page Fix

Current (wrong):
```typescript
const effRate = dailyRate / avgProductivity;
```

Fixed:
```typescript
const effRate = avgProductivity * dailyRate;
```
