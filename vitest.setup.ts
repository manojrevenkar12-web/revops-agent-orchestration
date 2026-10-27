// Tests talk to local emulators only; an outbound proxy configured in the environment must not intercept them.
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete process.env[k];
process.env.NO_PROXY = "127.0.0.1,localhost";
