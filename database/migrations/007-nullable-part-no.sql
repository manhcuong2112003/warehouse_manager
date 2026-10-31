ALTER TABLE products ALTER COLUMN part_no DROP NOT NULL;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_part_no_check;
ALTER TABLE products ADD CONSTRAINT products_part_no_check CHECK (part_no IS NULL OR length(part_no) > 0);
