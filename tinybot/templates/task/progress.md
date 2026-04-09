# Task Progress Report

## {{ title }} ({{ plan_id }})

**Status:** {{ status }}
**Progress:** {{ completed }}/{{ total }} completed

{% if current %}
**Current:** {{ current }}
{% endif %}

{% if next %}
**Next:** {{ next }}
{% endif %}

## Subtasks

{% for subtask in subtasks %}
- [{{ subtask.status_icon }}] {{ subtask.title }}
{% if subtask.result %}
  Result: {{ subtask.result }}
{% endif %}
{% if subtask.error %}
  Error: {{ subtask.error }}
{% endif %}
{% endfor %}