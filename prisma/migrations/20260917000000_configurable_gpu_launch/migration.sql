-- Existing deployments retain their original per-GPU prices. Configured launches
-- store an allocation/quote snapshot and an explicitly per-instance rate.
ALTER TABLE `pod_metadata`
  ADD COLUMN `hourly_rate_basis` VARCHAR(16) NOT NULL DEFAULT 'per_gpu',
  ADD COLUMN `launch_configuration` JSON NULL,
  ADD COLUMN `rate_snapshot` JSON NULL;

-- NULL retains a fixed offering. A configured rate card prices allowed resource
-- combinations without creating one product for each CPU/RAM/storage variant.
ALTER TABLE `gpu_product`
  ADD COLUMN `configuration_pricing` JSON NULL;

-- Encrypted model-access tokens are longer than the original plaintext column.
ALTER TABLE `hugging_face_deployment`
  MODIFY COLUMN `hf_token` TEXT NULL;
