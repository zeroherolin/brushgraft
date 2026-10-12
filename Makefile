# Shortcuts for setting up and running brushgraft. First time: make install, then make run.
.DEFAULT_GOAL := help
.PHONY: help install web run test check dist site deploy

# Everything runs in .venv inside the project; override with e.g. make run PY=python
ifeq ($(OS),Windows_NT)
PY ?= .venv/Scripts/python
else
PY ?= .venv/bin/python
endif

# Options for brushgraft, e.g. make run ARGS="--port 8080 --no-browser"
ARGS ?=

help:               ## list the commands
	@grep -E '^[a-z]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-9s %s\n", $$1, $$2}'

install:            ## create .venv, install dependencies and build the web UI
	@test -f external/promptbrush/pyproject.toml || git submodule update --init external/promptbrush
	@$(PY) --version >/dev/null 2>&1 || python3 -m venv .venv || python -m venv .venv
	$(PY) -m pip install --upgrade pip
	$(PY) -m pip install -e external/promptbrush -e . --group dev
	$(MAKE) web

web/node_modules: web/package-lock.json
	@command -v npm >/dev/null || { echo "Node.js is needed to build the web UI (see the README)." >&2; exit 1; }
	npm --prefix web ci
	@touch web/node_modules

web: web/node_modules  ## build the web UI into src/brushgraft/static
	npm --prefix web run build

run:                ## start brushgraft (options: make run ARGS="--port 8080")
	@$(PY) -c "import brushgraft" 2>/dev/null && test -f src/brushgraft/static/index.html \
		|| { echo "Not set up yet: run 'make install' first." >&2; exit 1; }
	$(PY) -m brushgraft $(ARGS)

test:               ## backend tests (offline)
	$(PY) -m pytest

check: test         ## lint, backend tests, web type check and web tests
	$(PY) -m ruff check .
	$(PY) scripts/export_spec.py --check
	npm --prefix web run check
	$(PY) scripts/parity_fixtures.py
	npm --prefix web test

site: web/node_modules  ## build the website (static files) into web/dist
	npm --prefix web run build:browser

deploy:             ## on the server: build and publish the website (see docs/deploy.md)
	python3 deploy/deploy.py $(ARGS)

dist: web           ## build the sdist and wheel (with the web UI)
	$(PY) -m pip install --quiet build
	$(PY) -m build
