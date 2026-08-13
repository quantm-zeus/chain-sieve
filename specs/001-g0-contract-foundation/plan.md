# G0 technical plan

Retain the TypeScript modular-monolith dependency direction and SQL-authoritative persistence. Implement through existing
domain/application ports; provider SDK types remain at adapters. Complete domain contracts first. Security perimeter and
collector can then proceed in parallel. Tool Core follows domain/security. Integration evidence is serialized after the
other packages. Material semantic ambiguity is recorded in an ADR and resolved from the complete relevant PRD sections.
