import re


def strip_think(text: str) -> str:
    """Remove <think>…</think> blocks and any unclosed trailing <think> tag."""
    text = re.sub(r"<think>[\s\S]*?</think>", "", text)
    text = re.sub(r"<think>[\s\S]*$", "", text)
    return text.strip()