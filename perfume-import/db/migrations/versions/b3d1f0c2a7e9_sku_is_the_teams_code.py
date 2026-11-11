"""the SKU is the team's own code: drop the old „SKU не съвпада с EAN“ block from saved products (decisions #32)

Revision ID: b3d1f0c2a7e9
Revises: 7c5abd4c6815
Create Date: 2026-11-11

"""

from collections.abc import Sequence

from alembic import op

revision: str = "b3d1f0c2a7e9"
down_revision: str | Sequence[str] | None = "7c5abd4c6815"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Validation results are saved with each field, so products made before the change keep the block until
    # this removes it: only the sku_formula issue goes; an SKU with nothing else wrong becomes ok.
    op.execute(
        """
        UPDATE fields SET
          issues = kept.issues,
          status = CASE WHEN kept.issues = '[]'::jsonb THEN 'ok' ELSE fields.status END,
          message = CASE WHEN kept.issues = '[]'::jsonb THEN NULL ELSE fields.message END,
          alternatives = '[]'::jsonb
        FROM (
          SELECT f.id, COALESCE(
            (SELECT jsonb_agg(e) FROM jsonb_array_elements(f.issues) e WHERE e->>'rule' <> 'sku_formula'),
            '[]'::jsonb) AS issues
          FROM fields f
          WHERE f.key = 'sku' AND f.issues @> '[{"rule": "sku_formula"}]'::jsonb
        ) AS kept
        WHERE fields.id = kept.id
        """
    )


def downgrade() -> None:
    pass  # the block is not brought back
