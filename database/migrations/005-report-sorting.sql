CREATE INDEX idx_pack_expiry ON stock_pack_balances(expired_date,mes_pack_no);
CREATE INDEX idx_movement_sort ON stock_movements(effective_at DESC,created_at DESC,id);
