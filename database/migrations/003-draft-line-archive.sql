ALTER TABLE inbound_draft_lines ADD COLUMN deleted boolean NOT NULL DEFAULT false;
ALTER TABLE inbound_draft_lines DROP CONSTRAINT uq_draft_line_mes_pack;
CREATE UNIQUE INDEX uq_draft_line_mes_pack ON inbound_draft_lines(draft_id,mes_pack_no) WHERE NOT deleted;
