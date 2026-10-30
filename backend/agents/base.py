"""Common agent machinery: message emission, timing, LLM call wrapper."""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any

from backend.llm.base import LLMError, LLMResult
from backend.orchestration.state import RegRadarState, RunContext
from backend.schemas import AgentMessage, LLMUsage, utcnow

log = logging.getLogger("regradar.agents")


class MessageBuffer:
    """Collects messages emitted during one node execution, numbering them globally."""

    def __init__(self, state: RegRadarState, ctx: RunContext, sender: str):
        """Start a buffer for one node execution.

        Args:
            state: Shared graph state. Its trace length gives the offset that keeps
                ``seq`` numbers increasing across every node of the run.
            ctx: Run-wide context, used here for the run id on each message.
            sender: Default sender for messages emitted through this buffer.
        """
        self._offset = len(state.get("trace") or [])
        self.ctx = ctx
        self.sender = sender
        self.messages: list[dict[str, Any]] = []

    def emit(
        self,
        recipient: str,
        message_type: str,
        summary: str,
        payload: dict[str, Any] | None = None,
        revision_round: int = 0,
        duration_ms: float | None = None,
        llm: LLMUsage | None = None,
        sender: str | None = None,
    ) -> dict[str, Any]:
        """Validate one trace message and append it to the buffer.

        Building an ``AgentMessage`` first means a malformed message fails here,
        at the agent that wrote it, instead of later when the trace is persisted.

        Args:
            recipient: Agent (or "orchestrator" / "human_reviewer") the message targets.
            message_type: One of the ``MessageType`` values shown in the trace filter.
            summary: One-line, human-readable description for the dashboard.
            payload: Structured detail shown behind "Show payload".
            revision_round: Feedback-loop cycle this message belongs to.
            duration_ms: Elapsed time, rounded to two decimals when supplied.
            llm: Which reasoning source produced this message, if any.
            sender: Overrides the buffer's default sender.

        Returns:
            The JSON-ready message dict that was appended.
        """
        msg = AgentMessage(
            id=uuid.uuid4().hex[:12],
            run_id=self.ctx.run_id,
            seq=self._offset + len(self.messages) + 1,
            timestamp=utcnow(),
            sender=sender or self.sender,
            recipient=recipient,
            message_type=message_type,  # type: ignore[arg-type]
            summary=summary,
            payload=payload or {},
            revision_round=revision_round,
            duration_ms=round(duration_ms, 2) if duration_ms is not None else None,
            llm=llm,
        )
        data = msg.model_dump(mode="json")
        self.messages.append(data)
        return data


class Agent:
    """Base class. Subclasses implement ``run(state, buf) -> dict``."""

    name: str = "agent"
    display_name: str = "Agent"
    role: str = ""

    def __init__(self, ctx: RunContext):
        """Keep the run context; agents hold no other state between graph nodes."""
        self.ctx = ctx

    def __call__(self, state: RegRadarState) -> dict[str, Any]:
        """Execute the agent as a LangGraph node.

        Wraps ``run`` with the behaviour every node shares: timing, a trace entry
        for failures, and the ``trace`` and ``route_history`` state updates.

        Raises:
            AgentFailure: If ``run`` raises. It carries the messages emitted so far,
                so the persisted trace shows what happened before the failure.
        """
        buf = MessageBuffer(state, self.ctx, self.name)
        started = time.perf_counter()
        try:
            update = self.run(state, buf)
        except Exception as exc:  # an agent must never crash the run silently
            log.exception("Agent %s failed", self.name)
            buf.emit("orchestrator", "error", f"{self.display_name} failed: {exc}", {"error": repr(exc)})
            raise AgentFailure(self.name, str(exc), buf.messages) from exc
        elapsed = (time.perf_counter() - started) * 1000
        if buf.messages:
            # attribute node duration to the final summary message of the node
            buf.messages[-1]["duration_ms"] = round(elapsed, 2)
        update["trace"] = buf.messages
        update["route_history"] = [self.name]
        return update

    def run(self, state: RegRadarState, buf: MessageBuffer) -> dict[str, Any]:  # pragma: no cover
        """Do the agent's work and return the state keys it changed."""
        raise NotImplementedError

    # ------------------------------------------------------------- LLM helper
    def call_llm(
        self, task: str, system: str, prompt: str, payload: dict[str, Any]
    ) -> tuple[LLMResult | None, LLMUsage]:
        """Call the run's LLM. Returns (result, usage); result is None on failure."""
        llm = self.ctx.llm
        try:
            result = llm.complete_json(task, system, prompt, payload)
        except (LLMError, ValueError) as exc:
            log.warning("LLM task %s failed for %s: %s", task, self.name, exc)
            return None, LLMUsage(
                provider=llm.provider,
                model=llm.model,
                reasoning_source="rule-based-fallback",
                fallback=True,
                error=str(exc)[:500],
            )
        return result, LLMUsage(provider=result.provider, model=result.model, reasoning_source=result.reasoning_source)


class AgentFailure(RuntimeError):
    """An agent crashed; carries its partial trace so the run can be stored as failed."""
    def __init__(self, agent: str, message: str, messages: list[dict[str, Any]]):
        super().__init__(f"{agent}: {message}")
        self.agent = agent
        self.messages = messages
