"""Agent 2 - Obligation Extractor: turns regulatory clauses into atomic obligations."""

from __future__ import annotations

import json
from typing import Any

from backend.agents.base import Agent, MessageBuffer
from backend.retrieval.text import detect_modal, detect_topics, extract_parameters, normalise_ws, split_sentences
from backend.schemas import Obligation, ObligationParameters, RegulatoryDocument

# VERBATIM matters: llm_based discards any obligation that is not found literally in its clause.
SYSTEM = (
    "You are a regulatory compliance analyst. Extract atomic obligations from regulation clauses. "
    "An obligation is a sentence that requires, recommends or permits an action using modal verbs "
    "such as shall, must, should or may. Copy the obligation text VERBATIM from the clause."
)



class ObligationExtractor(Agent):
    """Agent 2: converts document clauses into structured obligations.

    Live runs try the LLM first for each document and fall back to rules, so one
    failed call degrades that document only.
    """
    name = "obligation_extractor"
    display_name = "Obligation Extractor"
    role = "Splits clauses into sentences, detects modal verbs (shall/should/may) and parameters (deadlines, retention, frequency)."

    def _make(self, doc: RegulatoryDocument, ref: str, text: str, n: int, modal: str, strength: str, method: str) -> Obligation:
        """Build an obligation with its citation, parameters and topics.

        Args:
            doc: Source document.
            ref: Clause reference.
            text: Obligation sentence.
            n: 1-based position within the clause; later sentences get a "-n" id suffix.
            modal: Modal phrase found in the sentence.
            strength: mandatory, recommended or permissive.
            method: Extraction method recorded for the trace.
        """
        oid = f"{doc.id}:{ref}" + (f"-{n}" if n > 1 else "")
        return Obligation(
            id=oid,
            document_id=doc.id,
            regulator=doc.regulator,
            clause_ref=ref,
            citation=f"{doc.id} §{ref}",
            text=text,
            strength=strength,  # type: ignore[arg-type]
            modal=modal,
            parameters=ObligationParameters(**extract_parameters(text)),
            topics=detect_topics(text),
            effective=doc.effective,
            extraction_method=method,
        )

    def rule_based(self, doc: RegulatoryDocument) -> tuple[list[Obligation], int]:
        """Extract one obligation per sentence that contains a modal verb.

        Returns:
            The obligations, and how many clauses held no normative sentence.
        """
        obligations: list[Obligation] = []
        skipped = 0
        for clause in doc.clauses:
            n = 0
            for sentence in split_sentences(clause.text):
                found = detect_modal(sentence)
                if not found:
                    continue
                n += 1
                obligations.append(self._make(doc, clause.ref, sentence, n, found[0], found[1], "rule-based"))
            if n == 0:
                skipped += 1
        return obligations, skipped

    def llm_based(self, doc: RegulatoryDocument, buf: MessageBuffer) -> list[Obligation] | None:
        """Extract obligations with the LLM, keeping only verifiable ones.

        Each item must name a real clause, appear literally inside it and use a
        valid strength. Only the first 80 clauses are sent, to bound prompt size.

        Returns:
            Verified obligations, or None if the call failed or none survived,
            which tells ``run`` to use ``rule_based`` instead.
        """
        clauses = [{"ref": c.ref, "text": c.text} for c in doc.clauses[:80]]
        prompt = (
            f"Document: {doc.id} - {doc.title} ({doc.regulator})\n"
            f"Clauses (JSON):\n{json.dumps(clauses, ensure_ascii=False)}\n\n"
            'Return {"obligations": [{"clause_ref": str, "text": str (verbatim sentence), '
            '"strength": "mandatory"|"recommended"|"permissive", "modal": str}]}'
        )
        result, usage = self.call_llm("extract_obligations", SYSTEM, prompt, {"document": doc.model_dump(mode="json")})
        if result is None:
            buf.emit("orchestrator", "error", f"LLM extraction failed for {doc.id}; using rule-based extraction",
                     {"error": usage.error}, llm=usage)
            return None
        by_ref = {c.ref: normalise_ws(c.text).lower() for c in doc.clauses}
        accepted: list[Obligation] = []
        rejected = 0
        counts: dict[str, int] = {}
        for item in result.data.get("obligations", []):
            try:
                ref = str(item["clause_ref"])
                text = normalise_ws(str(item["text"]))
                strength = str(item.get("strength", "")).lower()
            except (KeyError, TypeError):
                rejected += 1
                continue
            # anti-hallucination: the obligation must literally appear in its clause
            if ref not in by_ref or text.lower() not in by_ref[ref] or strength not in ("mandatory", "recommended", "permissive"):
                rejected += 1
                continue
            counts[ref] = counts.get(ref, 0) + 1
            modal = str(item.get("modal") or (detect_modal(text) or ("", ""))[0])
            accepted.append(self._make(doc, ref, text, counts[ref], modal, strength, f"llm:{usage.provider}"))
        buf.emit(
            "orchestrator", "info",
            f"LLM proposed {len(accepted) + rejected} obligations for {doc.id}; kept {len(accepted)} verbatim, discarded {rejected}",
            {"document_id": doc.id, "kept": len(accepted), "discarded_not_verbatim": rejected},
            llm=usage,
        )
        return accepted if accepted else None

    def run(self, state, buf: MessageBuffer) -> dict[str, Any]:
        """Extract obligations from every document and report the totals to the trace."""
        docs = [RegulatoryDocument.model_validate(d) for d in state.get("documents", [])]
        obligations: list[Obligation] = []
        skipped_total = 0
        methods: dict[str, int] = {}
        for doc in docs:
            extracted = None
            if self.ctx.llm.is_live:
                extracted = self.llm_based(doc, buf)
            if extracted is None:
                extracted, skipped = self.rule_based(doc)
                skipped_total += skipped
            for ob in extracted:
                methods[ob.extraction_method] = methods.get(ob.extraction_method, 0) + 1
            obligations.extend(extracted)

        by_strength: dict[str, int] = {}
        for ob in obligations:
            by_strength[ob.strength] = by_strength.get(ob.strength, 0) + 1
        buf.emit(
            "control_mapper",
            "result",
            f"Extracted {len(obligations)} obligations "
            f"({', '.join(f'{v} {k}' for k, v in sorted(by_strength.items()))}); "
            f"{skipped_total} non-normative clause(s) skipped",
            {
                "obligation_count": len(obligations),
                "by_strength": by_strength,
                "methods": methods,
                "skipped_clauses": skipped_total,
                "obligations": [
                    {"id": o.id, "citation": o.citation, "strength": o.strength,
                     "parameters": o.parameters.model_dump(exclude_none=True)}
                    for o in obligations
                ],
            },
        )
        return {"obligations": [o.model_dump(mode="json") for o in obligations]}
