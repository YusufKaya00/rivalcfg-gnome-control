#!/usr/bin/env bash
set -euo pipefail

UUID="rivalcfg-control@yusufkaya00.github.io"
EXT_BASE="${HOME}/.local/share/gnome-shell/extensions"
DEST_DIR="${EXT_BASE}/${UUID}"

if command -v gsettings >/dev/null 2>&1; then
    CURRENT_EXTS="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo "@as []")"
    UPDATED_EXTS="$(python3 - "${CURRENT_EXTS}" "${UUID}" <<'PY'
import ast
import sys

raw = sys.argv[1].strip()
uuid = sys.argv[2]

if raw in ("", "@as []"):
    exts = []
else:
    if raw.startswith("@as "):
        raw = raw[4:].strip()
    exts = list(ast.literal_eval(raw))

filtered = [item for item in exts if item != uuid]
changed = filtered != exts

if filtered:
    formatted = "[" + ", ".join(repr(item) for item in filtered) + "]"
else:
    formatted = "@as []"

print(("CHANGED:" if changed else "UNCHANGED:") + formatted)
PY
)"
    if [[ "${UPDATED_EXTS}" == CHANGED:* ]]; then
        NEW_VAL="${UPDATED_EXTS#CHANGED:}"
        gsettings set org.gnome.shell enabled-extensions "${NEW_VAL}"
        echo "Removed '${UUID}' from org.gnome.shell enabled-extensions: ${NEW_VAL}"
    else
        echo "'${UUID}' was not present in org.gnome.shell enabled-extensions."
    fi
else
    echo "Warning: gsettings not found; skipping enabled-extensions update." >&2
fi

if [[ -d "${DEST_DIR}" ]]; then
    rm -rf "${DEST_DIR}"
    echo "Removed extension directory: ${DEST_DIR}"
else
    echo "Extension directory not found: ${DEST_DIR}"
fi

echo "Uninstalled ${UUID}."
