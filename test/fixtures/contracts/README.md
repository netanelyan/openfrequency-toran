# Contracts

One file for each internal API between accounts, Teder and Toran (PRA-QA-003): who serves it, who calls it, the
request, and every status it can answer, each with an example body. The prose in `docs/*.md` explains the rules; these
files are what the tests hold both sides to.

```
{ "name", "doc", "servedBy": [..], "calledBy": [..], "routes": [
    { "method", "path", "auth", "request": { "query" | "headers" | "body" },
      "answers": [ { "case", "status", "body", "nullable": [fields that may also be null] } ] } ] }
```

- **The side that serves an API** has a test that calls its real route, once for every case, and checks the answer
  against the case: the same status, and a body of the same shape (the same keys, the same types; a field in
  `nullable` may be null instead). accounts: `test/contracts.test.js`.
- **The side that calls it** builds its fake from the case's example, and checks that its client reads every case the
  way the case says.
- **These files are kept in openfrequency-accounts** and copied into Teder and Toran. A copy that differs from this
  repo's is a failure (each repo's contracts test compares them when the sibling checkout is there).
- A change to a contract changes the file here first, then both sides, deployed server first.
