"""Bounded runtime settings; never silently shorten user or tool messages."""
import os
from dataclasses import dataclass

from dotenv import dotenv_values


class AgentError(Exception):
    pass


@dataclass(frozen=True)
class AgentLimits:
    max_calls: int = 10
    output_tokens: int = 32768
    summary_tokens: int = 5000
    context_budget: int = 262144
    timeout_seconds: int = 300
    reasoning_effort: str = 'high'

    @classmethod
    def load(cls, root):
        env = {**dotenv_values(root / '.env'), **os.environ}
        ranges = {'max_calls': (1, 20), 'output_tokens': (1024, 393216),
                  'summary_tokens': (1024, 16384), 'context_budget': (32768, 1048576),
                  'timeout_seconds': (30, 1800)}
        values = {}
        for field, (low, high) in ranges.items():
            name = 'STUDIO_AGENT_' + field.upper()
            raw = env.get(name)
            if raw is None:
                continue
            try:
                value = int(raw)
                if not low <= value <= high:
                    raise ValueError()
            except (ValueError, TypeError):
                raise ValueError(f'{name} must be an integer in [{low}, {high}]') from None
            values[field] = value
        effort = env.get('STUDIO_AGENT_REASONING_EFFORT', 'high')
        if effort not in {'low', 'high'}:
            raise ValueError('STUDIO_AGENT_REASONING_EFFORT must be low or high')
        result = cls(**values, reasoning_effort=effort)
        if result.output_tokens + 8192 >= result.context_budget:
            raise ValueError('STUDIO_AGENT_CONTEXT_BUDGET must reserve room for input and output')
        return result


def estimated_input_units(messages, tools=None):
    """Conservative text byte budget, plus a reserve per resized image.

    This is an application guard, not the vendor tokenizer or a token count.
    Base64 bytes must not be mistaken for text tokens.
    """
    def measure(value):
        if isinstance(value, dict):
            if value.get('type') == 'image_url':
                return 1280  # Vendor maximum 1024 image tokens, plus reserve.
            return sum(len(str(k).encode('utf-8')) + measure(v) + 8 for k, v in value.items())
        if isinstance(value, list):
            return sum(measure(v) + 8 for v in value)
        return len(str(value).encode('utf-8')) + 8
    return measure(messages) + measure(tools or []) + 2048


def check_context(messages, tools, output_tokens, budget):
    if estimated_input_units(messages, tools) + output_tokens > budget:
        raise AgentError('本轮上下文已达到安全容量，未裁剪你的要求，也未继续调用工具。已有结果保留，请分批提出修改，或携带关键要求和参考图开启新创作。')


def bounded_text(value, maximum, label):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f'{label} must contain 1–{maximum} characters')
    return value
