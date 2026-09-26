# Costs (final)

## Run

|  | Calls | Input | Output | Reasoning | USD |
| --- | --- | --- | --- | --- | --- |
| total | 162 | 100335 | 48178 | 6600 | $0.3742 |

## By model

|  | Calls | Input | Output | Reasoning | USD |
| --- | --- | --- | --- | --- | --- |
| mock-lead | 37 | 21439 | 10453 | 1850 | $0.0830 |
| mock-vision | 36 | 23354 | 10112 | 1800 | $0.0829 |
| mock-agreeable | 29 | 20302 | 9177 | 1450 | $0.0734 |
| mock-critic | 30 | 17483 | 9467 | 1500 | $0.0723 |
| mock-flaky | 29 | 17757 | 8969 | 0 | $0.0626 |
| mock-broken | 1 | 0 | 0 | 0 | $0.0000 |

## By member

|  | Calls | Input | Output | Reasoning | USD |
| --- | --- | --- | --- | --- | --- |
| Agent F | 37 | 21439 | 10453 | 1850 | $0.0830 |
| Agent E | 36 | 23354 | 10112 | 1800 | $0.0829 |
| Agent C | 29 | 20302 | 9177 | 1450 | $0.0734 |
| Agent B | 30 | 17483 | 9467 | 1500 | $0.0723 |
| Agent A | 29 | 17757 | 8969 | 0 | $0.0626 |
| Agent D | 1 | 0 | 0 | 0 | $0.0000 |

## By stage

|  | Calls | Input | Output | Reasoning | USD |
| --- | --- | --- | --- | --- | --- |
| do | 52 | 32908 | 16465 | 2150 | $0.1260 |
| discuss | 32 | 20887 | 9693 | 1300 | $0.0759 |
| meeting | 30 | 17829 | 8109 | 1200 | $0.0644 |
| red-team | 20 | 12654 | 5769 | 800 | $0.0455 |
| specialist | 16 | 9631 | 5158 | 700 | $0.0389 |
| verify | 9 | 4864 | 2550 | 300 | $0.0191 |
| clarify | 2 | 1062 | 324 | 100 | $0.0032 |
| plan | 1 | 500 | 110 | 50 | $0.0013 |

## Last cost.update from the engine

```json
{
  "totalUsd": 0.374225,
  "totalTokens": {
    "input": 100335,
    "output": 48178,
    "reasoning": 6600
  },
  "byMember": {
    "m1": {
      "usd": 0.08295400000000001,
      "input": 21439,
      "output": 10453,
      "reasoning": 1850,
      "calls": 37
    },
    "m2": {
      "usd": 0.07231800000000001,
      "input": 17483,
      "output": 9467,
      "reasoning": 1500,
      "calls": 30
    },
    "m3": {
      "usd": 0.073437,
      "input": 20302,
      "output": 9177,
      "reasoning": 1450,
      "calls": 29
    },
    "m4": {
      "usd": 0.08291400000000002,
      "input": 23354,
      "output": 10112,
      "reasoning": 1800,
      "calls": 36
    },
    "m5": {
      "usd": 0.062602,
      "input": 17757,
      "output": 8969,
      "reasoning": 0,
      "calls": 29
    }
  },
  "byStage": {
    "clarify": {
      "usd": 0.003182,
      "input": 1062,
      "output": 324,
      "reasoning": 100,
      "calls": 2
    },
    "plan": {
      "usd": 0.0013,
      "input": 500,
      "output": 110,
      "reasoning": 50,
      "calls": 1
    },
    "do": {
      "usd": 0.12598299999999996,
      "input": 32908,
      "output": 16465,
      "reasoning": 2150,
      "calls": 52
    },
    "verify": {
      "usd": 0.019114,
      "input": 4864,
      "output": 2550,
      "reasoning": 300,
      "calls": 8
    },
    "discuss": {
      "usd": 0.075852,
      "input": 20887,
      "output": 9693,
      "reasoning": 1300,
      "calls": 32
    },
    "meeting": {
      "usd": 0.064374,
      "input": 17829,
      "output": 8109,
      "reasoning": 1200,
      "calls": 30
    },
    "specialist": {
      "usd": 0.038921000000000004,
      "input": 9631,
      "output": 5158,
      "reasoning": 700,
      "calls": 16
    },
    "red-team": {
      "usd": 0.04549900000000001,
      "input": 12654,
      "output": 5769,
      "reasoning": 800,
      "calls": 20
    }
  }
}
```

_Per-call detail: costs.jsonl and members/<label>/calls.jsonl._
