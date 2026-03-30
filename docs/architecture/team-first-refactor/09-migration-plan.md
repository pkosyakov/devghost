# Migration Plan

Status: starter

## Strategy

Use a strangler migration:

- keep legacy ingestion and run engine;
- introduce domain facade/read layer;
- populate shadow business entities asynchronously;
- move UI surfaces one by one.

## Initial migration order

1. contributor identity
2. repository and PR surfaces
3. team model
4. saved view and persistent scope
5. schedule, curation, and diagnostics polish

## Legacy compatibility rule

The frontend may temporarily consume both legacy and new APIs, but each new surface must choose one canonical contract and not mix semantics inside the same screen.
