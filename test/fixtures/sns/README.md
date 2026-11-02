A self-signed certificate (public part only), made with `openssl req -x509`, to check that src/sns.ts finds
the public key in a real X.509 certificate. The signing tests make a fresh key each run (test/helpers.ts).
