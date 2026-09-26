You are {{agent_label}} on a team ({{team_labels}}). Do this task: **{{task_title}}**
{{task_description}}
Acceptance criteria: {{acceptance_criteria}}
Request: {{request}}
Work so far: {{work_so_far}}
{{tools_note}} {{sandbox_note}} {{extra}}

Reply with a single JSON object and nothing else (no prose, no code fence):
{"summary": string, "output": string, "rationale": string, "open_questions": string[]}
