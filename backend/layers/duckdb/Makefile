# DuckDB for the functions that query raw data (template.yaml: DuckDbLayer, built by `sam build`).
# Installs the linux-arm64 bindings whatever the build machine is, and bundles the httpfs extension so
# nothing is downloaded when a function starts. Keep NODE_API_VERSION in step with backend/package.json.
NODE_API_VERSION := 2.0.0-r.1
DUCKDB_VERSION := 2.0.0
PLATFORM := linux_arm64

build-DuckDbLayer:
	mkdir -p "$(ARTIFACTS_DIR)/nodejs" "$(ARTIFACTS_DIR)/duckdb_extensions/v$(DUCKDB_VERSION)/$(PLATFORM)"
	npm install --prefix "$(ARTIFACTS_DIR)/nodejs" --os=linux --cpu=arm64 --omit=dev --no-audit --no-fund --no-package-lock \
		@duckdb/node-api@$(NODE_API_VERSION)
	curl -fsSL "https://extensions.duckdb.org/v$(DUCKDB_VERSION)/$(PLATFORM)/httpfs.duckdb_extension.gz" \
		| gunzip > "$(ARTIFACTS_DIR)/duckdb_extensions/v$(DUCKDB_VERSION)/$(PLATFORM)/httpfs.duckdb_extension"
	rm -f "$(ARTIFACTS_DIR)/nodejs/package.json"
