import json
import unittest
from unittest.mock import MagicMock, patch

from services.protocol.conversation import (
    ConversationRequest,
    ConversationState,
    assistant_message_text,
    is_thought_assistant_message,
    is_visible_assistant_message,
    iter_conversation_payloads,
    stream_text_events,
)
from services.protocol.openai_v1_chat_complete import (
    completion_response,
    stream_text_chat_completion,
)
from utils.helper import split_image_model


class TestReasoningAndImages(unittest.TestCase):
    def test_split_image_models_new_variants(self):
        plan, base = split_image_model("gpt-image-2.5")
        self.assertEqual(base, "gpt-image-2.5")
        self.assertIsNone(plan)

        plan, base = split_image_model("gpt-image-2.5-flare")
        self.assertEqual(base, "gpt-image-2.5-flare")
        self.assertIsNone(plan)

        plan, base = split_image_model("gpt-image-2.5-sunburst")
        self.assertEqual(base, "gpt-image-2.5-sunburst")
        self.assertIsNone(plan)

    def test_thought_message_detection(self):
        msg_thought = {
            "author": {"role": "assistant"},
            "channel": "thought",
            "content": {"content_type": "thoughts", "parts": ["Thinking step 1..."]},
        }
        self.assertTrue(is_thought_assistant_message(msg_thought))
        self.assertFalse(is_visible_assistant_message(msg_thought))

        msg_final = {
            "author": {"role": "assistant"},
            "channel": "final",
            "content": {"content_type": "text", "parts": ["Hello world!"]},
        }
        self.assertFalse(is_thought_assistant_message(msg_final))
        self.assertTrue(is_visible_assistant_message(msg_final))

    def test_iter_conversation_payloads_with_reasoning(self):
        payloads = [
            # 1. Thought start
            json.dumps({
                "message": {
                    "id": "msg-1",
                    "author": {"role": "assistant"},
                    "channel": "thought",
                    "content": {"content_type": "thoughts", "parts": ["I should"]},
                }
            }),
            # 2. Patch to thought
            json.dumps({
                "p": "/message/content/parts/0",
                "o": "append",
                "v": " verify the facts.",
            }),
            # 3. Final answer starts
            json.dumps({
                "message": {
                    "id": "msg-2",
                    "author": {"role": "assistant"},
                    "channel": "final",
                    "content": {"content_type": "text", "parts": ["The answer is 42."]},
                }
            }),
            # 4. Patch to final answer
            json.dumps({
                "p": "/message/content/parts/0",
                "o": "append",
                "v": " Exactly.",
            }),
            "[DONE]",
        ]

        events = list(iter_conversation_payloads(iter(payloads)))
        reasoning_deltas = [e["delta"] for e in events if e["type"] == "conversation.reasoning_delta"]
        content_deltas = [e["delta"] for e in events if e["type"] == "conversation.delta"]

        self.assertEqual(reasoning_deltas, ["I should", " verify the facts."])
        self.assertEqual(content_deltas, ["The answer is 42.", " Exactly."])

    def test_stream_text_chat_completion_yields_reasoning_content(self):
        # Mock stream_text_events
        mock_backend = MagicMock()
        mock_backend.access_token = "mock-token"

        fake_events = [
            {"type": "conversation.reasoning_delta", "delta": "Thinking..."},
            {"type": "conversation.delta", "delta": "Hello!"},
        ]

        with patch("services.protocol.openai_v1_chat_complete.stream_text_events", return_value=iter(fake_events)):
            chunks = list(stream_text_chat_completion(mock_backend, [{"role": "user", "content": "hi"}], "gpt-6"))

        # Chunk 1: role + reasoning_content
        first_delta = chunks[0]["choices"][0]["delta"]
        self.assertEqual(first_delta.get("role"), "assistant")
        self.assertEqual(first_delta.get("reasoning_content"), "Thinking...")

        # Chunk 2: content
        second_delta = chunks[1]["choices"][0]["delta"]
        self.assertEqual(second_delta.get("content"), "Hello!")

        # Final chunk: finish_reason stop
        last_choice = chunks[-1]["choices"][0]
        self.assertEqual(last_choice.get("finish_reason"), "stop")

    def test_completion_response_includes_reasoning(self):
        resp = completion_response(
            model="gpt-6",
            content="Final answer",
            messages=[{"role": "user", "content": "test"}],
            reasoning_content="Deep thoughts",
        )
        msg = resp["choices"][0]["message"]
        self.assertEqual(msg["content"], "Final answer")
        self.assertEqual(msg["reasoning_content"], "Deep thoughts")
        self.assertGreater(resp["usage"]["completion_tokens_details"]["reasoning_tokens"], 0)


if __name__ == "__main__":
    unittest.main()
