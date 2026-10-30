## What & why

<!-- What does this change, and why? Link the issue it closes (e.g. "Closes #12"). -->

## Checklist

- [ ] I edited the root `src/` / `public/` (not the copies) and ran `npm run sync`
- [ ] `npm test` passes
- [ ] I added or updated tests (required for anything touching PIN / tokens / access control)
- [ ] Mobile app changes: `cd HosterApp && npx tsc --noEmit && npx jest`
- [ ] Docs / CHANGELOG updated if behaviour changed
- [ ] Tested on a real device (say which, or "not tested on a device")
