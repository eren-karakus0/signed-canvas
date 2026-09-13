"""One deal, written out so a stranger can check every claim in it.

Not a summary. A summary is the author's account of what happened, and the point of this
document is that the reader does not have to take the author's account: every frame is here
verbatim, with the room and sequence it landed at, and the delivery answer carries the
sequence it was taken at. Each of those is a URL somebody else can fetch.

What the document must not do is imply more than the protocol delivers. It states the outcome
of the hash lock, which is that a secret matching the statement was revealed — and it states,
in the same breath, that this proves who accepted rather than that any work was done, and that
no rail in the deal held value.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import deal as deal_module
import job
from record import DealRecord

ROOM_URL = "https://technocore.chat/r"


def _when(epoch: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(epoch))


def render(record: DealRecord, delivery: dict[str, Any] | None) -> str:
    """The transcript, as Markdown."""
    entries = record.frames
    rebuilt = deal_module.rebuild(entries, int(time.time() * 1000))
    offer = rebuilt.offer
    rehearsal = bool(record.get("rehearsal"))

    lines: list[str] = []
    lines.append(f"# tclk deal `{record.contract[:18]}…`")
    lines.append("")
    if rehearsal:
        lines.append(
            "> **This is a rehearsal, not commerce.** Both identities in it are ours. It is "
            "here to show the frames are well formed, and it must not be read as trade."
        )
        lines.append("")

    lines.append(f"| | |")
    lines.append(f"|---|---|")
    lines.append(f"| contract | `{record.contract}` |")
    lines.append(f"| state | **{rebuilt.state.value}** |")
    lines.append(f"| payer | `{rebuilt.payer or '—'}` |")
    lines.append(f"| payee | `{rebuilt.payee or 'nobody accepted'}` |")
    lines.append(
        f"| amount | {offer.get('amount')} {offer.get('asset')} on `{offer.get('rails')}` |"
    )
    lines.append(f"| job | `{(offer.get('job') or {}).get('id', '—')}` |")
    lines.append(f"| opened | {_when(record.get('opened_at', 0))} |")
    lines.append("")

    lines.append("## What actually happened")
    lines.append("")
    if not entries[1:]:
        lines.append(
            "Nothing after the offer. Nobody accepted it, which on this canvas is an ordinary "
            "outcome rather than a failure: the measurement behind this work found one lock "
            "for every twenty offers in the room."
        )
    else:
        lines.append("| # | frame | from | room · seq | seen |")
        lines.append("|---|---|---|---|---|")
        for n, entry in enumerate(entries, 1):
            lines.append(
                f"| {n} | `{entry['label']}` | `{entry['from'][8:24]}…` | "
                f"[{entry['room']} · {entry['seq']}]({ROOM_URL}/{entry['room']}) | "
                f"{_when(entry['seen_at'])} |"
            )
    lines.append("")

    lines.append("## The frames, verbatim")
    lines.append("")
    lines.append(
        "Byte for byte as signed. The room served each with its signature, so anyone"
    )
    lines.append(
        "can re-verify authorship against the canonical string `<room>|<nonce>|<text>`."
    )
    lines.append("")
    for entry in entries:
        lines.append(f"**{entry['label']}** — {entry['room']} seq {entry['seq']}")
        lines.append("")
        lines.append("```json")
        lines.append(json.dumps(entry["frame"], sort_keys=True, separators=(",", ":")))
        lines.append("```")
        lines.append("")

    lines.append("## The deliverable")
    lines.append("")
    if delivery is None:
        lines.append("No delivery check was taken for this deal.")
    else:
        region = delivery["region"]
        lines.append(
            f"Region **{region['w']}×{region['h']} at ({region['x']},{region['y']})**, "
            f"answered as of archive sequence **{delivery['at']}**."
        )
        lines.append("")
        lines.append(f"- wanted: **{delivery['wanted']}** cells")
        lines.append(f"- correct: **{delivery['right']}**")
        lines.append(f"- wrong colour: **{len(delivery['wrong'])}**")
        lines.append(f"- not painted: **{len(delivery['missing'])}**")
        lines.append("")
        if delivery["painters"]:
            lines.append("Painted by:")
            lines.append("")
            for did, count in sorted(delivery["painters"].items(), key=lambda p: -p[1]):
                lines.append(f"- `{did}` — {count} cells")
            lines.append("")
        lines.append(
            "As of a sequence rather than as of now, because the canvas is world-writable: "
            "a third party can paint over a delivered region, and the same question asked a "
            "minute later would have a different answer. Check any cell yourself at "
            "`/api/cell/<x>/<y>`."
        )
    lines.append("")

    lines.append("## What this does and does not prove")
    lines.append("")
    lines.append(
        "**Proved.** Every frame above was signed by the key it names and stored by a service "
        "neither party runs. If a `reveal` is present, its secret hashes to the statement the "
        "`accept` committed to — that is the one cryptographic link in the sequence."
    )
    lines.append("")
    lines.append(
        "**Not proved.** That any work was done. tclk's hash lock binds payment to revealing a "
        "secret, and the payee mints that secret — so revealing it establishes who accepted, "
        "not what they delivered. Delivery is settled separately, by the region answer above, "
        "which anyone can recompute from the archive."
    )
    lines.append("")
    lines.append(
        "**No value moved.** tclk is alpha and no rail holds value; the reference `PaperRail` "
        "records and holds nothing. Every amount in this document is symbolic."
    )
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("contract")
    parser.add_argument("--deals", type=Path, default=Path("deals"))
    parser.add_argument(
        "--plan", type=Path, help="the commission, to take a delivery answer"
    )
    parser.add_argument("--archive", default="https://signed-canvas.vercel.app/api")
    parser.add_argument("--at", type=int, help="settle as of this archive sequence")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    path = args.deals / f"{args.contract[2:18]}.json"
    if not path.exists():
        print(f"no deal record at {path}", file=sys.stderr)
        return 1
    record = DealRecord(path)

    delivery = None
    if args.plan:
        try:
            delivery = job.delivered(job.load_plan(args.plan), args.archive, args.at)
        except job.JobError as exc:
            print(f"the delivery answer could not be taken: {exc}", file=sys.stderr)
            return 1

    document = render(record, delivery)
    out = args.out or args.deals / f"{args.contract[2:18]}.md"
    out.write_text(document, encoding="utf-8")
    print(f"written: {out}  ({len(document)} characters)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
