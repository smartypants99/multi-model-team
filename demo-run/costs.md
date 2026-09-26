# Costs (final)

## Run

|  | Calls | Input | Output | Reasoning | USD |
| --- | --- | --- | --- | --- | --- |
| total | 147 | 90626 | 44116 | 6000 | $0.3412 |

## By model

|  | Calls | Input | Output | Reasoning | USD |
| --- | --- | --- | --- | --- | --- |
| mock-lead | 34 | 19123 | 9720 | 1700 | $0.0762 |
| mock-vision | 33 | 20590 | 8870 | 1650 | $0.0732 |
| mock-critic | 27 | 17021 | 8801 | 1350 | $0.0678 |
| mock-agreeable | 26 | 17130 | 8632 | 1300 | $0.0668 |
| mock-flaky | 26 | 16762 | 8093 | 0 | $0.0572 |
| mock-broken | 1 | 0 | 0 | 0 | $0.0000 |

## By member

|  | Calls | Input | Output | Reasoning | USD |
| --- | --- | --- | --- | --- | --- |
| Agent C | 34 | 19123 | 9720 | 1700 | $0.0762 |
| Agent D | 33 | 20590 | 8870 | 1650 | $0.0732 |
| Agent B | 27 | 17021 | 8801 | 1350 | $0.0678 |
| Agent F | 26 | 17130 | 8632 | 1300 | $0.0668 |
| Agent E | 26 | 16762 | 8093 | 0 | $0.0572 |
| Agent A | 1 | 0 | 0 | 0 | $0.0000 |

## By stage

|  | Calls | Input | Output | Reasoning | USD |
| --- | --- | --- | --- | --- | --- |
| do | 37 | 24674 | 11389 | 1550 | $0.0894 |
| discuss | 32 | 20887 | 9693 | 1300 | $0.0759 |
| meeting | 30 | 17967 | 9083 | 1200 | $0.0694 |
| red-team | 20 | 10745 | 6261 | 800 | $0.0460 |
| specialist | 16 | 9927 | 4706 | 700 | $0.0370 |
| verify | 9 | 4864 | 2550 | 300 | $0.0191 |
| clarify | 2 | 1062 | 324 | 100 | $0.0032 |
| plan | 1 | 500 | 110 | 50 | $0.0013 |

## Last cost.update from the engine

```json
{
  "totalUsd": 0.341206,
  "totalTokens": {
    "input": 90626,
    "output": 44116,
    "reasoning": 6000
  },
  "byMember": {
    "m1": {
      "usd": 0.07622300000000001,
      "input": 19123,
      "output": 9720,
      "reasoning": 1700,
      "calls": 34
    },
    "m2": {
      "usd": 0.067776,
      "input": 17021,
      "output": 8801,
      "reasoning": 1350,
      "calls": 27
    },
    "m3": {
      "usd": 0.06679,
      "input": 17130,
      "output": 8632,
      "reasoning": 1300,
      "calls": 26
    },
    "m4": {
      "usd": 0.07319000000000003,
      "input": 20590,
      "output": 8870,
      "reasoning": 1650,
      "calls": 33
    },
    "m5": {
      "usd": 0.057227,
      "input": 16762,
      "output": 8093,
      "reasoning": 0,
      "calls": 26
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
      "usd": 0.089369,
      "input": 24674,
      "output": 11389,
      "reasoning": 1550,
      "calls": 37
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
      "usd": 0.069382,
      "input": 17967,
      "output": 9083,
      "reasoning": 1200,
      "calls": 30
    },
    "specialist": {
      "usd": 0.036957,
      "input": 9927,
      "output": 4706,
      "reasoning": 700,
      "calls": 16
    },
    "red-team": {
      "usd": 0.046049999999999994,
      "input": 10745,
      "output": 6261,
      "reasoning": 800,
      "calls": 20
    }
  }
}
```

_Per-call detail: costs.jsonl and members/<label>/calls.jsonl._
