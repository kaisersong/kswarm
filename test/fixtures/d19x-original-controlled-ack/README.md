# Frozen controlled ACK history

`manifest.json` identifies exact production module bodies extracted from the
Host-registration review packet. Hashes are verified before loading. No body is
edited and no SQL is used to manufacture a prepared fact.

The original Hub and SQLite backend first produce a prepared observation through
their real controlled-Source API. A second module tree replaces only the rules
with the actual current rules and reopens the same database. Its other frozen
runtime ABI dependencies preserve the original floor and history bytes.

This proves current-rule historical read/replay behavior under that frozen ABI.
It does not prove a current complete binary may adopt an old floor, and does not
qualify the controlled Source, marker metadata or ACK as Native/Host authority.
Fresh current runtime ACKs remain denied until their real effect qualification.
