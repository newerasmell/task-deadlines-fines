---
name: perfume-researcher
description: Explains how product research works; the research itself runs in pipeline/research.py
tools: Read
---
Research is no longer done by this subagent. It runs through the Claude API in `pipeline/research.py` so the same
code serves the CLI (`scripts/new_batch.py`) and the web app. Read that file for the rules: sources per fact,
vocab-only gender and fragrance family, status decided by code (ok with 2+ supporting websites), never an EAN or price.
