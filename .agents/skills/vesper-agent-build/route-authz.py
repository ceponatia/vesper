#!/usr/bin/env python3
"""Predict which changed resource-ID routes `pnpm lint:authz` will reject.

    route-authz.py --gate scripts/check-route-authz.ts <changed path>...

scan-diff.sh calls this with the content-changed paths of a branch; it keeps
those that match the gate's RESOURCE_ROUTE. It prints each route holding a bare
`withUser` handler with no authorization evidence and exits 1 if any does.
Otherwise it exits 0 when every route passes, 2 when the gate cannot be read or
its mirrored constants changed, 3 when a route cannot be read or anything else
fails, and 64 on a usage error. The caller reports 2 and 3 rather than
skipping silently.

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
that adds a helper is judged by its own list. The gate's matching constants
must still read as MIRRORED below, or this refuses to predict. The function
logic is mirrored by hand: a change there must be ported here, with a row in
tests/scan-diff.sh.

Standard library only; it reads the gate as text and never imports or runs it.
"""
import re
import sys

# JavaScript's \w and \b are ASCII-only, but its \s also matches these spaces.
JS_SPACE = r"[\s   -     　﻿]"


def js(pattern):
    """Compile a JavaScript regex source (no `\\s` inside a character class)."""
    return re.compile(pattern.replace(r"\s", JS_SPACE), re.ASCII)


# The gate's constants, spelled as its source declares them.
MIRRORED = (
    r"const WITH_USER_CALL = /\bwithUser(?:<[^>\n]+>)?\s*\(/g;",
    r"const OWNER_TOKEN = /\bowner(?:Id|_id)\b/;",
    r"const USER_ID = /\buser\.id\b/;",
    "const GUARD_CHECK_LOOKAHEAD = 4;",
    "const GUARD_EXIT_LOOKAHEAD = 3;",
)
WITH_USER_CALL = js(r"\bwithUser(?:<[^>\n]+>)?\s*\(")
OWNER_TOKEN = js(r"\bowner(?:Id|_id)\b")
USER_ID = js(r"\buser\.id\b")
GUARD_CHECK_LOOKAHEAD = 4
GUARD_EXIT_LOOKAHEAD = 3
EXIT = js(r"\breturn\b|\bthrow\b")
NEGATED_IF = js(r"\bif\s*\(\s*!")
BINDING = js(r"(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=")


class GateError(Exception):
    pass


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
    call = js(r"\." + method + r"\s*\(")
    return [call_arguments(stripped, m.end() - 1) for m in call.finditer(stripped)]


def route_parameter_names(path):
    return [m for m in js(r"\[(?:\.\.\.)?([A-Za-z_$][\w$]*)\]").findall(path) if m]


def has_route_param(text, params):
    """A route parameter used as a variable, not the `.id` property of a table."""
    return any(js(r"(?:^|[^.$\w])" + p + r"\b").search(text) for p in params)


def exits_within(lines, at):
    last = min(at + GUARD_EXIT_LOOKAHEAD, len(lines) - 1)
    return any(EXIT.search(lines[i]) for i in range(at, last + 1))


def result_is_guarded(lines, call_line):
    line = lines[call_line] if call_line < len(lines) else ""
    if NEGATED_IF.search(line) and exits_within(lines, call_line):
        return True
    binding = BINDING.search(line)
    if not binding:
        return False
    name = binding.group(1)
    negated = js(r"\bif\s*\(\s*!\s*" + name + r"\b")
    compared = js(r"\bif\s*\(\s*" + name + r"\s*={2,3}\s*(?:null|undefined|false)\b")
    chosen = js(r"\b" + name + r"\s*\?\??(?!\.)")
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
        for m in js(r"\b" + helper + r"\s*\(").finditer(stripped):
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
    """(RESOURCE_ROUTE, helper names) from the gate's source text, or GateError."""
    text = strip_comments(gate_source)
    drifted = [line for line in MIRRORED if line not in text]
    if drifted:
        raise GateError("its matching constants changed; port the change to route-authz.py: " + " ".join(drifted))
    # A regex literal body: escapes, character classes (which may hold a bare
    # `/`, as `[^/]` does), and any other character but `/`.
    route = re.search(
        r"\bRESOURCE_ROUTE\s*=\s*/((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\[\n])+)/([a-z]*)\s*;", text
    )
    if not route or set(route.group(2)) - set("iu"):
        raise GateError("no RESOURCE_ROUTE regex literal it can read")
    helpers = re.search(r"\bAPPROVED_ROUTE_AUTHZ_HELPERS\s*=\s*\[([^\]]*)\]", text)
    literal = js(r"([\"'`])([A-Za-z_$][\w$]*)\1")
    # Only quoted names, commas and whitespace: a spread or a computed entry
    # would otherwise be dropped and its helper judged unapproved.
    if not helpers or literal.sub("", helpers.group(1)).strip(" \t\r\n,"):
        raise GateError("no APPROVED_ROUTE_AUTHZ_HELPERS list of plain names it can read")
    names = [m.group(2) for m in literal.finditer(helpers.group(1))]
    if not names:
        raise GateError("APPROVED_ROUTE_AUTHZ_HELPERS is empty")
    try:
        flags = re.ASCII | (re.IGNORECASE if "i" in route.group(2) else 0)
        return re.compile(route.group(1), flags), names
    except re.error as error:
        raise GateError(f"RESOURCE_ROUTE does not compile here ({error})") from error


def read_text(path):
    # errors="replace" and newline="" match Node's readFileSync(path, "utf8"),
    # which the gate uses: invalid bytes become U+FFFD and a lone \r stays a \r.
    with open(path, encoding="utf-8", errors="replace", newline="") as fh:
        return fh.read()


def main(argv):
    if len(argv) < 2 or argv[0] != "--gate":
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        return 64
    try:
        resource_route, helpers = read_gate(read_text(argv[1]))
    except (OSError, GateError) as error:
        print(f"cannot predict lint:authz from {argv[1]}: {error}", file=sys.stderr)
        return 2
    unsafe, unreadable = [], []
    for path in argv[2:]:
        if not resource_route.search(path):
            continue
        try:
            source = read_text(path)
        except OSError as error:
            unreadable.append(f"{path} ({error.strerror})")
            continue
        if not has_authorization_evidence(path, source, resource_route, helpers):
            unsafe.append(path)
    if unreadable:
        print("cannot read changed route(s): " + ", ".join(unreadable), file=sys.stderr)
        return 3
    for path in unsafe:
        print(path)
    return 1 if unsafe else 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as error:  # an uncaught traceback exits 1, which means "unsafe"
        print(f"route-authz.py failed: {error!r}", file=sys.stderr)
        sys.exit(3)
