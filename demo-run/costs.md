# Costs (final)

## Run

|  | Calls | Input | Output | Reasoning | USD |
| --- | --- | --- | --- | --- | --- |
| total | 207 | 127951 | 62143 | 8400 | $0.4807 |

## By model

|  | Calls | Input | Output | Reasoning | USD |
| --- | --- | --- | --- | --- | --- |
| mock-vision | 45 | 28173 | 13153 | 2250 | $0.1052 |
| mock-lead | 46 | 26466 | 13273 | 2300 | $0.1043 |
| mock-critic | 39 | 24244 | 12617 | 1950 | $0.0971 |
| mock-agreeable | 38 | 23969 | 11613 | 1900 | $0.0915 |
| mock-flaky | 38 | 25099 | 11487 | 0 | $0.0825 |
| mock-broken | 1 | 0 | 0 | 0 | $0.0000 |

## By member

|  | Calls | Input | Output | Reasoning | USD |
| --- | --- | --- | --- | --- | --- |
| Agent A | 45 | 28173 | 13153 | 2250 | $0.1052 |
| Agent E | 46 | 26466 | 13273 | 2300 | $0.1043 |
| Agent C | 39 | 24244 | 12617 | 1950 | $0.0971 |
| Agent D | 38 | 23969 | 11613 | 1900 | $0.0915 |
| Agent F | 38 | 25099 | 11487 | 0 | $0.0825 |
| Agent B | 1 | 0 | 0 | 0 | $0.0000 |

## By stage

|  | Calls | Input | Output | Reasoning | USD |
| --- | --- | --- | --- | --- | --- |
| do | 97 | 60263 | 28903 | 3950 | $0.2245 |
| discuss | 32 | 20887 | 9693 | 1300 | $0.0759 |
| meeting | 30 | 16756 | 9552 | 1200 | $0.0705 |
| red-team | 20 | 13075 | 6149 | 800 | $0.0478 |
| specialist | 16 | 10544 | 4862 | 700 | $0.0384 |
| verify | 9 | 4864 | 2550 | 300 | $0.0191 |
| clarify | 2 | 1062 | 324 | 100 | $0.0032 |
| plan | 1 | 500 | 110 | 50 | $0.0013 |

## Last cost.update from the engine

```json
{
  "totalUsd": 0.480666,
  "totalTokens": {
    "input": 127951,
    "output": 62143,
    "reasoning": 8400
  },
  "byMember": {
    "m1": {
      "usd": 0.10433100000000001,
      "input": 26466,
      "output": 13273,
      "reasoning": 2300,
      "calls": 46
    },
    "m2": {
      "usd": 0.097079,
      "input": 24244,
      "output": 12617,
      "reasoning": 1950,
      "calls": 39
    },
    "m3": {
      "usd": 0.09153399999999999,
      "input": 23969,
      "output": 11613,
      "reasoning": 1900,
      "calls": 38
    },
    "m4": {
      "usd": 0.10518799999999999,
      "input": 28173,
      "output": 13153,
      "reasoning": 2250,
      "calls": 45
    },
    "m5": {
      "usd": 0.08253399999999998,
      "input": 25099,
      "output": 11487,
      "reasoning": 0,
      "calls": 38
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
      "usd": 0.224528,
      "input": 60263,
      "output": 28903,
      "reasoning": 3950,
      "calls": 97
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
      "usd": 0.070516,
      "input": 16756,
      "output": 9552,
      "reasoning": 1200,
      "calls": 30
    },
    "specialist": {
      "usd": 0.038354,
      "input": 10544,
      "output": 4862,
      "reasoning": 700,
      "calls": 16
    },
    "red-team": {
      "usd": 0.04782000000000001,
      "input": 13075,
      "output": 6149,
      "reasoning": 800,
      "calls": 20
    }
  }
}
```

_Per-call detail: costs.jsonl and members/<label>/calls.jsonl._
