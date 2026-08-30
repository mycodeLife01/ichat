"""Normalize visible Gemini thoughts as reasoning summaries."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260830_0020"
down_revision: str | None = "20260830_0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_GEMINI_DETAIL_EXISTS = """
EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(transcript.blocks, '[]'::jsonb)) AS block
    CROSS JOIN LATERAL jsonb_array_elements(
        coalesce(block->'payload'->'reasoning_details', '[]'::jsonb)
    ) AS detail
    WHERE detail->>'type' = 'reasoning.text'
      AND detail->>'format' = 'google-gemini-v1'
)
"""


def upgrade() -> None:
    # OpenRouter labels Gemini's externally visible thought summaries as
    # reasoning.text. Preserve the wire blocks verbatim, but correct the neutral
    # transcript block kind and every derived read projection.
    op.execute(
        sa.text(
            f"""
            UPDATE run_provider_messages AS transcript
            SET blocks = (
                SELECT jsonb_agg(
                    CASE
                        WHEN block->>'type' = 'reasoning'
                         AND coalesce(block->>'kind', 'raw') = 'raw'
                        THEN jsonb_set(block, '{{kind}}', '"summary"'::jsonb, true)
                        ELSE block
                    END
                    ORDER BY position
                )
                FROM jsonb_array_elements(transcript.blocks)
                     WITH ORDINALITY AS item(block, position)
            )
            WHERE {_GEMINI_DETAIL_EXISTS}
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            UPDATE run_events AS event
            SET payload = jsonb_set(event.payload, '{{kind}}', '"summary"'::jsonb, true)
            WHERE event.type = 'reasoning_delta'
              AND coalesce(event.payload->>'kind', 'raw') = 'raw'
              AND EXISTS (
                  SELECT 1
                  FROM run_provider_messages AS transcript
                  WHERE transcript.run_id = event.run_id
                    AND {_GEMINI_DETAIL_EXISTS}
              )
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            UPDATE messages AS message
            SET reasoning_summary = message.reasoning,
                reasoning = NULL
            WHERE coalesce(btrim(message.reasoning), '') <> ''
              AND coalesce(btrim(message.reasoning_summary), '') = ''
              AND EXISTS (
                  SELECT 1
                  FROM run_provider_messages AS transcript
                  WHERE transcript.run_id = message.run_id
                    AND {_GEMINI_DETAIL_EXISTS}
              )
            """
        )
    )
    op.execute(
        sa.text(
            """
            UPDATE model_routes AS route
            SET reasoning_outputs = '["summary"]'::jsonb,
                updated_at = now()
            FROM model_upstreams AS upstream
            WHERE route.upstream_id = upstream.id
              AND upstream.adapter = 'openrouter'
              AND route.upstream_model LIKE 'google/gemini-%'
              AND route.reasoning_outputs ? 'raw'
            """
        )
    )


def downgrade() -> None:
    # This migration corrects semantic classification of existing provider facts.
    # Reconstructing the former misclassification would corrupt newer messages.
    pass
