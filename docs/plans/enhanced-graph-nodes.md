---
plan name: enhanced-graph-nodes
plan description: Add research and plan nodes
plan status: active
---

## Idea
Implement enhanced graph structure with research and plan nodes, plus richer prompt templates for all node types. The goal is to match the depth of opencode's manual /research, /plan, /execute workflow while keeping the orchestrated automation. This adds: (1) research node for deep codebase investigation with artifact output, (2) plan node for creating phased implementation plans from research artifacts, (3) implement node that executes plan phases, (4) test node that verifies against plan criteria, (5) finalize node that reviews completeness. Also adds enhanced prompt templates with process guidance, decision trees, error handling, and verification criteria. Artifacts (research docs, plan docs) persist across sessions in a thoughts directory.

## Implementation
- Create artifact persistence system in workspace/thoughts/ for research and plan documents
- Add new node types to graph executor: research and plan nodes with artifact reading/writing support
- Create enhanced base prompt templates for each node type (research, plan, implement, test, finalize) with process guidance, decision trees, error handling, and verification criteria
- Update executeGraph to support artifact passing between nodes (research output → plan input, plan output → implement input, etc.)
- Update planner default prompt to generate 5-node graphs (research→plan→implement→test→finalize) when appropriate
- Add tests for new node types and artifact persistence
- Update documentation to describe new node types and their responsibilities
- Verify backward compatibility with existing 2-4 node graphs still works

## Required Specs
<!-- SPECS_START -->
<!-- SPECS_END -->