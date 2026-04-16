# Run with: python openai-python-smoke-test.py (requires: pip install openai, dzupagent server running with echo agent)
"""
OpenAI Python SDK smoke test for DzupAgent's OpenAI-compatible API.

Prerequisites:
  1. pip install openai
  2. Start the DzupAgent server with at least one agent registered as "echo":
       yarn workspace @dzupagent/server dev
     (or any server that registers an agent with id "echo")
  3. The server must be listening on http://localhost:3000

Usage:
  python openai-python-smoke-test.py

This script is NOT run in CI. It is a manual verification tool to confirm
that the OpenAI Python SDK can talk to DzupAgent's /v1 endpoints.
"""

import sys

from openai import OpenAI


BASE_URL = "http://localhost:3000/v1"
API_KEY = "test"
MODEL = "echo"


def test_non_streaming() -> None:
    """Test non-streaming chat completion."""
    print("[1/3] Testing non-streaming chat completion...")

    client = OpenAI(base_url=BASE_URL, api_key=API_KEY)
    response = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": "hello"}],
    )

    # Validate response shape
    assert response.id.startswith("chatcmpl-"), f"Unexpected ID format: {response.id}"
    assert response.object == "chat.completion", f"Unexpected object: {response.object}"
    assert response.model == MODEL, f"Unexpected model: {response.model}"
    assert len(response.choices) >= 1, "Expected at least one choice"

    choice = response.choices[0]
    assert choice.message.role == "assistant", f"Unexpected role: {choice.message.role}"
    assert choice.message.content is not None, "Expected non-null content"
    assert choice.finish_reason == "stop", f"Unexpected finish_reason: {choice.finish_reason}"

    assert response.usage is not None, "Expected usage to be present"
    assert response.usage.total_tokens == (
        response.usage.prompt_tokens + response.usage.completion_tokens
    ), "total_tokens != prompt_tokens + completion_tokens"

    print(f"  Response: {choice.message.content!r}")
    print(f"  Usage: {response.usage.prompt_tokens}p + {response.usage.completion_tokens}c = {response.usage.total_tokens}t")
    print("  PASSED")


def test_streaming() -> None:
    """Test streaming chat completion."""
    print("[2/3] Testing streaming chat completion...")

    client = OpenAI(base_url=BASE_URL, api_key=API_KEY)
    stream = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": "hello streaming"}],
        stream=True,
    )

    chunks_received = 0
    assembled_content = ""
    saw_stop = False

    for chunk in stream:
        chunks_received += 1
        assert chunk.object == "chat.completion.chunk", f"Unexpected chunk object: {chunk.object}"
        assert chunk.id.startswith("chatcmpl-"), f"Unexpected chunk ID: {chunk.id}"

        if chunk.choices:
            choice = chunk.choices[0]
            if choice.delta.content:
                assembled_content += choice.delta.content
            if choice.finish_reason == "stop":
                saw_stop = True

    assert chunks_received >= 1, "Expected at least one chunk"
    assert saw_stop, "Expected a chunk with finish_reason='stop'"

    print(f"  Chunks received: {chunks_received}")
    print(f"  Assembled content: {assembled_content!r}")
    print("  PASSED")


def test_models_list() -> None:
    """Test model listing."""
    print("[3/3] Testing GET /v1/models...")

    client = OpenAI(base_url=BASE_URL, api_key=API_KEY)
    models = client.models.list()

    model_ids = [m.id for m in models.data]
    assert len(model_ids) >= 1, "Expected at least one model"
    assert MODEL in model_ids, f"Expected '{MODEL}' in model list, got: {model_ids}"

    print(f"  Models: {model_ids}")
    print("  PASSED")


def main() -> None:
    """Run all smoke tests."""
    print(f"DzupAgent OpenAI SDK Smoke Test")
    print(f"Base URL: {BASE_URL}")
    print(f"Model: {MODEL}")
    print("=" * 50)

    try:
        test_non_streaming()
        test_streaming()
        test_models_list()
    except AssertionError as e:
        print(f"\nFAILED: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"\nERROR: {e}", file=sys.stderr)
        print("Is the DzupAgent server running at http://localhost:3000?", file=sys.stderr)
        sys.exit(1)

    print("=" * 50)
    print("All tests passed")


if __name__ == "__main__":
    main()
