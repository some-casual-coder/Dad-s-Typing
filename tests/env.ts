const url = new URL(process.env.DATABASE_URL!);
url.pathname = `/${process.env.TEST_DB_NAME ?? "dads_typing_test"}`;
process.env.DATABASE_URL = url.toString();
