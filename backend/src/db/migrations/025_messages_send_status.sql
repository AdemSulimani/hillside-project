-- Outbound delivery status (e.g. channel API failures after the row was created)
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS send_status VARCHAR(50),
  ADD COLUMN IF NOT EXISTS send_error VARCHAR(2000);

COMMENT ON COLUMN messages.send_status IS 'e.g. failed when Meta/WhatsApp send errored after persist';
COMMENT ON COLUMN messages.send_error IS 'Provider or transport error message when send_status is set';
