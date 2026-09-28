#!/usr/bin/env python3
"""Predict which changed resource-ID routes `pnpm lint:authz` will reject.

    route-authz.py --gate scripts/check-route-authz.ts <route.ts>...

scan-diff.sh calls this with the content-changed `route.ts` paths of a branch.
It prints each path that holds a bare `withUser` handler with no authorization
evidence and exits 1 if any does. It exits 0 when every path passes, 2 when the
gate's lists cannot be read, and 3 on any other failure; the caller reports 2
and 3 rather than skipping silently.

This is a port of `resourceRouteHasAuthorizationEvidence` in
`scripts/check-route-authz.ts`, which the local-gate ban forbids running here.
It judges each `withUser(` / `withUser<Params>(` handler the way the gate
does. A handler passes when it has either of these:

  * a call to an APPROVED_ROUTE_AUTHZ_HELPERS name, given `user.id` and a route
    parameter, whose result guards an early return or throw nearby;
  * one `.where(...)` span naming `user.id`, an owner column and a route
    parameter.

Wrapper handlers (`withOwnedChat`, `withAuthorizedResource`, ...) pass because
they are not `withUser` calls, exactly as in the gate. The helper list and
RESOURCE_ROUTE are read from the gate file of the tree being scanned, so a PR
that adds a helper is judged by its own list. Everything else is mirrored by
hand: a change to the gate's matching logic must be ported here, with a row in
tests/scan-diff.sh.

Standard library only; it reads the gate as text and never imports or runs it.
"""
import re
import sys

A = re.ASCII  # JavaScript's \w and \b are ASCII-only

WITH_USER_CALL = re.compile(r"\bwithUser(?:<[^>\n]+>)?\s*\(", A)
OWNER_TOKEN = re.compile(r"\bowner(?:Id|_id)\b", A)
USER_ID = re.compile(r"\buser\.id\b", A)
EXIT = re.compile(r"\breturn\b|\bthrow\b", A)
GUARD_CHECK_LOOKAHEAD = 4
GUARD_EXIT_LOOKAHEAD = 3


def strip_comments(source):
    """Blank // and /* */ comments, keeping offsets and newlines stable."""
    out = list(source)
    mode, quote, i = "code", "", 0
    while i < len(out):
        char = out[i]
        nxt = out[i + 1] if i + 1 < len(out) else ""
        if mode == "code":
            if char == "/" and nxt in ("/", "*"):
                mode = "line" if nxt == "/" else "block"
                out[i] = " "
                out[i + 1] = " "
                i += 1
            elif char in ("\"", "'", "`"):
                mode, quote = "quote", char
        elif mode == "line":
            if char == "\n":
                mode = "code"
            else:
                out[i] = " "
        elif mode == "block":
            if char == "*" and nxt == "/":
                out[i] = " "
                out[i + 1] = " "
                i += 1
                mode = "code"
            elif char != "\n":
                out[i] = " "
        elif char == "\\":
            i += 1
        elif char == quote:
            mode = "code"
        i += 1
    return "".join(out)


def match_delimiter(text, open_at, open_char, close_char):
    depth, quote, i = 0, "", open_at
    while i < len(text):
        char = text[i]
        if quote:
            if char == "\\":
                i += 1
            elif char == quote:
                quote = ""
        elif char in ("\"", "'", "`"):
            quote = char
        elif char == open_char:
            depth += 1
        elif char == close_char:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def call_arguments(text, open_at):
    close = match_delimiter(text, open_at, "(", ")")
    return text[open_at + 1:] if close == -1 else text[open_at + 1:close]


def method_call_arguments(source, method):
    stripped = strip_comments(source)
    call = re.compile(r"\." + method + r"\s*\(", A)
    return [call_arguments(stripped, m.end() - 1) for m in call.finditer(stripped)]


def route_parameter_names(path):
    return [m for m in re.findall(r"\[(?:\.\.\.)?([A-Za-z_$][\w$]*)\]", path, A) if m]


def has_route_param(text, params):
    """A route parameter used as a variable, not the `.id` property of a table."""
    return any(re.search(r"(?:^|[^.$\w])" + p + r"\b", text, A) for p in params)


def exits_within(lines, at):
    last = min(at + GUARD_EXIT_LOOKAHEAD, len(lines) - 1)
    return any(EXIT.search(lines[i]) for i in range(at, last + 1))


def result_is_guarded(lines, call_line):
    line = lines[call_line] if call_line < len(lines) else ""
    if re.search(r"\bif\s*\(\s*!", line, A) and exits_within(lines, call_line):
        return True
    binding = re.search(r"(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=", line, A)
    if not binding:
        return False
    name = binding.group(1)
    negated = re.compile(r"\bif\s*\(\s*!\s*" + name + r"\b", A)
    compared = re.compile(r"\bif\s*\(\s*" + name + r"\s*={2,3}\s*(?:null|undefined|false)\b", A)
    chosen = re.compile(r"\b" + name + r"\s*\?\??(?!\.)", A)
    last = min(len(lines) - 1, call_line + GUARD_CHECK_LOOKAHEAD)
    for i in range(call_line, last + 1):
        candidate = lines[i]
        if (negated.search(candidate) or compared.search(candidate)) and exits_within(lines, i):
            return True
        if i > call_line and chosen.search(candidate):
            return True
    return False


def has_guarded_authorization_helper(source, params, helpers):
    stripped = strip_comments(source)
    lines = stripped.split("\n")
    for helper in helpers:
        for m in re.finditer(r"\b" + helper + r"\s*\(", stripped, A):
            args = call_arguments(stripped, m.end() - 1)
            if USER_ID.search(args) and has_route_param(args, params):
                if result_is_guarded(lines, stripped.count("\n", 0, m.start())):
                    return True
    return False


def has_inline_ownership_predicate(source, params):
    return any(
        USER_ID.search(span) and OWNER_TOKEN.search(span) and has_route_param(span, params)
        for span in method_call_arguments(source, "where")
    )


def with_user_bodies(source):
    stripped = strip_comments(source)
    return [call_arguments(stripped, m.end() - 1) for m in WITH_USER_CALL.finditer(stripped)]


def has_authorization_evidence(path, source, resource_route, helpers):
    if not resource_route.search(path):
        return True
    params = route_parameter_names(path)
    return all(
        has_guarded_authorization_helper(body, params, helpers) or has_inline_ownership_predicate(body, params)
        for body in with_user_bodies(source)
    )


def read_gate(gate_source):
    """(RESOURCE_ROUTE, helper names) from the gate's source text, or None."""
    text = strip_comments(gate_source)
    # A regex literal body: escapes, character classes (which may hold a bare
    # `/`, as `[^/]` does), and any other character but `/`.
    route = re.search(
        r"\bRESOURCE_ROUTE\s*=\s*/((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\[\n])+)/([a-z]*)\s*;", text
    )
    helpers = re.search(r"\bAPPROVED_ROUTE_AUTHZ_HELPERS\s*=\s*\[([^\]]*)\]", text)
    if not route or not helpers or set(route.group(2)) - set("iu"):
        return None
    names = re.findall(r"[\"']([A-Za-z_$][\w$]*)[\"']", helpers.group(1), A)
    if not names:
        return None
    try:
        pattern = re.compile(route.group(1), re.IGNORECASE if "i" in route.group(2) else 0)
    except re.error:
        return None
    return pattern, names


def main(argv):
    if len(argv) < 2 or argv[0] != "--gate":
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        return 64
    try:
        # errors="replace" mirrors Node's readFileSync(path, "utf8"), which the
        # gate uses: invalid bytes decode to U+FFFD instead of raising.
        with open(argv[1], encoding="utf-8", errors="replace") as fh:
            gate = read_gate(fh.read())
    except OSError:
        gate = None
    if gate is None:
        print(f"cannot read RESOURCE_ROUTE and APPROVED_ROUTE_AUTHZ_HELPERS from {argv[1]}", file=sys.stderr)
        return 2
    resource_route, helpers = gate
    unsafe = 0
    for path in argv[2:]:
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                source = fh.read()
        except OSError:
            continue  # deleted in the working tree; the gate reads only present files
        if not has_authorization_evidence(path, source, resource_route, helpers):
            print(path)
            unsafe += 1
    return 1 if unsafe else 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as error:  # an uncaught traceback exits 1, which means "unsafe"
        print(f"route-authz.py failed: {error!r}", file=sys.stderr)
        sys.exit(3)
