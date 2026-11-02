import { emdashPluginTest } from "@emdash-cms/plugin-test/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [emdashPluginTest()],
	test: {
		// Sandboxed plugin hosts boot workerd; keep runs sequential so D1 and
		// Worker Loader bindings stay isolated per test.
		fileParallelism: false,
		pool: "forks",
		env: {
			// Test-only key so EmDash's secret settings can encrypt. This value is
			// never used outside the test run and never leaves the repository.
			EMDASH_ENCRYPTION_KEY: "emdash_enc_v1_2SSl_TboCwLhbf-c1Y5JUynx3V5EyzL_hk5tkv8CqXI",
		},
	},
});
