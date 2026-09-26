# Costs (final)

## Run

|  | Calls | Input | Output | Reasoning | USD |
| --- | --- | --- | --- | --- | --- |
| total | 147 | 90626 | 44116 | 6000 | $0.3412 |

## By model

|  | Calls | Input | Output | Reasoning | USD |
| --- | --- | --- | --- | --- | --- |
| mock-lead | 34 | 20196 | 9360 | 1700 | $0.0755 |
| mock-vision | 33 | 20932 | 9180 | 1650 | $0.0751 |
| mock-critic | 27 | 17372 | 8987 | 1350 | $0.0691 |
| mock-agreeable | 26 | 16179 | 8550 | 1300 | $0.0654 |
| mock-flaky | 26 | 15947 | 8039 | 0 | $0.0561 |
| mock-broken | 1 | 0 | 0 | 0 | $0.0000 |

## By member

|  | Calls | Input | Output | Reasoning | USD |
| --- | --- | --- | --- | --- | --- |
| Agent C | 34 | 20196 | 9360 | 1700 | $0.0755 |
| Agent D | 33 | 20932 | 9180 | 1650 | $0.0751 |
| Agent F | 27 | 17372 | 8987 | 1350 | $0.0691 |
| Agent B | 26 | 16179 | 8550 | 1300 | $0.0654 |
| Agent E | 26 | 15947 | 8039 | 0 | $0.0561 |
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
      "usd": 0.07549600000000001,
      "input": 20196,
      "output": 9360,
      "reasoning": 1700,
      "calls": 34
    },
    "m2": {
      "usd": 0.06905699999999998,
      "input": 17372,
      "output": 8987,
      "reasoning": 1350,
      "calls": 27
    },
    "m3": {
      "usd": 0.06542900000000001,
      "input": 16179,
      "output": 8550,
      "reasoning": 1300,
      "calls": 26
    },
    "m4": {
      "usd": 0.07508200000000001,
      "input": 20932,
      "output": 9180,
      "reasoning": 1650,
      "calls": 33
    },
    "m5": {
      "usd": 0.056142,
      "input": 15947,
      "output": 8039,
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
