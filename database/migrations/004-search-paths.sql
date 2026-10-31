CREATE INDEX idx_pack_product ON stock_pack_balances(product_id);
CREATE INDEX idx_pack_vendor_search ON stock_pack_balances USING gin(vendor_code gin_trgm_ops);
CREATE INDEX idx_part_prefix_ci ON products(lower(part_no) text_pattern_ops);
