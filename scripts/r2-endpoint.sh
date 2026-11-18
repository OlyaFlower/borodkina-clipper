#!/usr/bin/env bash
# Sourced by the scripts that talk to R2. Sets $endpoint.
# R2_ENDPOINT unset or empty: the EU-jurisdiction endpoint of R2_ACCOUNT_ID (dev's bucket). A bucket in the
# default jurisdiction (prod) sets the Environment variable R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com.
# Anything else is refused, so a mistyped variable cannot send media elsewhere. Only the integration tests
# (CI's S3 stand-in) set R2_ENDPOINT_ALLOW_ANY=1 to use a local endpoint.
r2_account="${R2_ACCOUNT_ID:?}"
endpoint="${R2_ENDPOINT:-https://${r2_account}.eu.r2.cloudflarestorage.com}"
if [[ "${R2_ENDPOINT_ALLOW_ANY:-}" != 1 ]]; then
  [[ "$r2_account" =~ ^[0-9a-f]{32}$ ]] || { echo "bad R2_ACCOUNT_ID" >&2; exit 2; }
  if [[ "$endpoint" != "https://${r2_account}.r2.cloudflarestorage.com" \
    && "$endpoint" != "https://${r2_account}.eu.r2.cloudflarestorage.com" ]]; then
    echo "R2_ENDPOINT must be https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com or https://<R2_ACCOUNT_ID>.eu.r2.cloudflarestorage.com" >&2
    exit 2
  fi
fi
unset r2_account
