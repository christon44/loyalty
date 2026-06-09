import {authenticate, unauthenticated} from "../shopify.server";

function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Max-Age": "7200",
    },
  });
}

export const loader = async ({request}) => {
  await authenticate.public.checkout(request);
};

export const action = async ({request}) => {
  if (request.method === "OPTIONS") {
    return preflight();
  }

  let cors = (response) => {
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type",
    );
    return response;
  };

  try {
    const checkout = await authenticate.public.checkout(request);
    cors = checkout.cors;
    const {sessionToken} = checkout;

    const {orderId} = await request.json();

    if (!orderId) {
      return cors(Response.json({error: "Invalid order ID"}, {status: 400}));
    }

    const adminOrderId = orderId.replace(
      "gid://shopify/OrderIdentity/",
      "gid://shopify/Order/",
    );

    const shop = sessionToken.dest.replace(/^https?:\/\//, "");
    const {admin} = await unauthenticated.admin(shop);

    const response = await admin.graphql(
      `#graphql
      query GetOrderCustomerStoreCredit($orderId: ID!) {
        shop {
          currencyCode
        }
        order(id: $orderId) {
          subtotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalReceivedSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          transactions {
            formattedGateway
            gateway
            kind
            status
            amountSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
          customer {
            id
            firstName
            displayName
            email
            storeCreditAccounts(first: 10) {
              nodes {
                balance {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }`,
      {
        variables: {orderId: adminOrderId},
      },
    );

    const result = await response.json();

    if (result.errors) {
      console.error("Store credit query failed", result.errors);
      return cors(
        Response.json({error: "Unable to fetch store credit"}, {status: 500}),
      );
    }

    const customer = result.data?.order?.customer;
    const appstleLoyalty = await fetchAppstleLoyalty(shop, customer?.id);
    const savedAmount =
      getStoreCreditUsed(result.data?.order?.transactions) ||
      getStoreCreditUsedFromCardTransactions(
        result.data?.order?.transactions,
        result.data?.order?.totalPriceSet?.shopMoney,
      ) ||
      getStoreCreditUsedFromTotals(result.data?.order);
    const credits = getLatestCredits(
      appstleLoyalty,
      customer?.storeCreditAccounts?.nodes,
      result.data?.shop?.currencyCode,
    );
    const earnedCredit = getCurrentOrderEarnedCredit(result.data?.order, appstleLoyalty);

    return cors(
      Response.json({
        credits,
        savedAmount,
        earnedCredit,
        firstName: getCustomerFirstName(customer),
        isCustomerInSystem: Boolean(customer),
        isMembershipCustomer: Boolean(appstleLoyalty),
        vipTier: appstleLoyalty?.currentVipTier || null,
      }),
    );
  } catch (error) {
    console.error("Store credit route failed", error);

    return cors(
      Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Unable to load store credit",
        },
        {status: 500},
      ),
    );
  }
};

async function fetchAppstleLoyalty(shop, customerGid) {
  const apiKey = process.env.APPSTLE_API_KEY;
  const customerId = customerGid?.replace("gid://shopify/Customer/", "");

  console.log("[Appstle] shop:", shop, "customerId:", customerId, "hasApiKey:", Boolean(apiKey));

  if (!apiKey || !shop || !customerId) {
    console.log("[Appstle] missing required param, skipping");
    return null;
  }

  try {
    const url = new URL(
      "https://loyalty-admin.appstle.com/api/external/customer-loyalty",
    );
    url.searchParams.set("shop", shop);
    url.searchParams.set("customer_id", customerId);

    const response = await fetch(url, {
      headers: {"X-API-Key": apiKey},
    });

    console.log("[Appstle] response status:", response.status);

    if (!response.ok) {
      const body = await response.text();
      console.error("[Appstle] lookup failed", response.status, body);
      return null;
    }

    const loyalty = await response.json();
    console.log("[Appstle] loyalty data:", JSON.stringify(loyalty));

    if (!loyalty || typeof loyalty !== "object") {
      return null;
    }

    const storeCreditBalance = Number(loyalty?.storeCreditBalance);

    return {
      ...loyalty,
      storeCreditBalance: Number.isFinite(storeCreditBalance)
        ? storeCreditBalance
        : 0,
    };
  } catch (error) {
    console.error("[Appstle] lookup failed", error);
    return null;
  }
}

function getCustomerFirstName(customer) {
  if (customer?.firstName) {
    return customer.firstName;
  }

  const displayName = customer?.displayName?.trim();
  if (displayName) {
    return displayName.split(/\s+/)[0];
  }

  const emailName = customer?.email?.split("@")[0]?.trim();
  if (emailName) {
    return emailName.split(/[._-]/)[0];
  }

  return "";
}

function getLatestCredits(loyalty, storeCreditAccounts, shopCurrencyCode) {
  const appstleBalance = Number(loyalty?.storeCreditBalance);

  if (Number.isFinite(appstleBalance) && appstleBalance > 0 && shopCurrencyCode) {
    return [{amount: roundMoney(appstleBalance), currencyCode: shopCurrencyCode}];
  }

  return (
    storeCreditAccounts
      ?.map((account) => account.balance)
      ?.filter((balance) => Number(balance.amount) > 0) || []
  );
}

function getCurrentOrderEarnedCredit(currentOrder, loyalty) {
  if (!loyalty?.customerStatus) return null;

  const storeCreditBalance = Number(loyalty?.storeCreditBalance);
  if (!Number.isFinite(storeCreditBalance) || storeCreditBalance <= 0) return null;

  const currencyCode =
    currentOrder?.subtotalPriceSet?.shopMoney?.currencyCode ||
    currentOrder?.totalPriceSet?.shopMoney?.currencyCode;
  if (!currencyCode) return null;

  return {
    amount: roundMoney(storeCreditBalance),
    currencyCode,
  };
}

function roundMoney(amount) {
  return Math.round(amount * 100) / 100;
}

function isStoreCreditGateway(t) {
  const gatewayText = [t.gateway, t.formattedGateway].filter(Boolean).join(" ");
  const normalized = gatewayText.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized.includes("storecredit");
}

function getStoreCreditUsed(transactions) {
  if (!transactions?.length) return null;

  const isActive = (t) => ["SUCCESS", "PENDING"].includes(t.status);

  // Prefer SALE/CAPTURE (captured) over AUTHORIZATION (pending capture)
  // to avoid double-counting when both exist for the same payment
  const captured = transactions.filter(
    (t) => isActive(t) && ["SALE", "CAPTURE"].includes(t.kind) && isStoreCreditGateway(t),
  );
  const matches = captured.length
    ? captured
    : transactions.filter(
        (t) => isActive(t) && t.kind === "AUTHORIZATION" && isStoreCreditGateway(t),
      );

  if (!matches.length) return null;

  const currencyCode = matches[0].amountSet?.shopMoney?.currencyCode;
  const savedAmount = matches.reduce(
    (total, t) => total + Number(t.amountSet?.shopMoney?.amount || 0),
    0,
  );

  if (!Number.isFinite(savedAmount) || savedAmount <= 0 || !currencyCode) {
    return null;
  }

  return {amount: roundMoney(savedAmount), currencyCode};
}

function getStoreCreditUsedFromCardTransactions(transactions, totalPrice) {
  if (!transactions?.length || !totalPrice?.currencyCode) return null;

  const isActive = (t) => ["SUCCESS", "PENDING"].includes(t.status);

  const cardTransactions = transactions.filter(
    (t) =>
      isActive(t) &&
      ["SALE", "CAPTURE"].includes(t.kind) &&
      !isStoreCreditGateway(t) &&
      t.amountSet?.shopMoney?.currencyCode === totalPrice.currencyCode,
  );

  if (!cardTransactions.length) return null;

  const cardTotal = cardTransactions.reduce(
    (sum, t) => sum + Number(t.amountSet?.shopMoney?.amount || 0),
    0,
  );

  if (!Number.isFinite(cardTotal) || cardTotal <= 0) return null;

  const priceAmount = Number(totalPrice.amount);
  const savedAmount = priceAmount - cardTotal;

  if (!Number.isFinite(savedAmount) || savedAmount <= 0) return null;

  return {amount: roundMoney(savedAmount), currencyCode: totalPrice.currencyCode};
}

function getStoreCreditUsedFromTotals(order) {
  const totalPrice = order?.totalPriceSet?.shopMoney;
  const totalReceived = order?.totalReceivedSet?.shopMoney;

  if (
    totalPrice?.currencyCode !== totalReceived?.currencyCode ||
    !totalPrice?.currencyCode
  ) {
    return null;
  }

  const priceAmount = Number(totalPrice.amount);
  const receivedAmount = Number(totalReceived.amount);

  if (!Number.isFinite(receivedAmount) || receivedAmount <= 0) return null;

  const savedAmount = priceAmount - receivedAmount;

  if (!Number.isFinite(savedAmount) || savedAmount <= 0) {
    return null;
  }

  return {
    amount: roundMoney(savedAmount),
    currencyCode: totalPrice.currencyCode,
  };
}
