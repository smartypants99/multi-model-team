# Costs (final)

## Run

|  | Calls | Input | Output | Reasoning | USD |
| --- | --- | --- | --- | --- | --- |
| total | 162 | 100335 | 48178 | 6600 | $0.3742 |

## By model

|  | Calls | Input | Output | Reasoning | USD |
| --- | --- | --- | --- | --- | --- |
| mock-lead | 37 | 21641 | 10812 | 1850 | $0.0850 |
| mock-vision | 36 | 22945 | 9809 | 1800 | $0.0810 |
| mock-agreeable | 29 | 20341 | 9275 | 1450 | $0.0740 |
| mock-critic | 30 | 16888 | 9598 | 1500 | $0.0724 |
| mock-flaky | 29 | 18520 | 8684 | 0 | $0.0619 |
| mock-broken | 1 | 0 | 0 | 0 | $0.0000 |

## By member

|  | Calls | Input | Output | Reasoning | USD |
| --- | --- | --- | --- | --- | --- |
| Agent D | 37 | 21641 | 10812 | 1850 | $0.0850 |
| Agent C | 36 | 22945 | 9809 | 1800 | $0.0810 |
| Agent F | 29 | 20341 | 9275 | 1450 | $0.0740 |
| Agent A | 30 | 16888 | 9598 | 1500 | $0.0724 |
| Agent E | 29 | 18520 | 8684 | 0 | $0.0619 |
| Agent B | 1 | 0 | 0 | 0 | $0.0000 |

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
      "usd": 0.08495100000000001,
      "input": 21641,
      "output": 10812,
      "reasoning": 1850,
      "calls": 37
    },
    "m2": {
      "usd": 0.07237800000000001,
      "input": 16888,
      "output": 9598,
      "reasoning": 1500,
      "calls": 30
    },
    "m3": {
      "usd": 0.073966,
      "input": 20341,
      "output": 9275,
      "reasoning": 1450,
      "calls": 29
    },
    "m4": {
      "usd": 0.08099,
      "input": 22945,
      "output": 9809,
      "reasoning": 1800,
      "calls": 36
    },
    "m5": {
      "usd": 0.061939999999999995,
      "input": 18520,
      "output": 8684,
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
