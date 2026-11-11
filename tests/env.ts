const url = new URL(process.env.DATABASE_URL!);
url.pathname = "/dads_typing_test";
process.env.DATABASE_URL = url.toString();
