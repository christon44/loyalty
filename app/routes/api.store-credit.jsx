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
          createdAt
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
            firstName
            displayName
            email
            appstleLoyalty: metafield(
              namespace: "appstle_loyalty"
              key: "customer_loyalty"
            ) {
              value
            }
            appOwnedAppstleLoyalty: metafield(
              namespace: "app--18394152961--appstle_loyalty"
              key: "customer_loyalty"
            ) {
              value
            }
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
    const appstleLoyalty = parseFirstAppstleLoyalty(
      customer?.appstleLoyalty?.value,
      customer?.appOwnedAppstleLoyalty?.value,
    );
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
      result.data?.order,
      savedAmount,
    );
    const earnedCredit = getCurrentOrderEarnedCredit(
      appstleLoyalty,
      customer?.storeCreditAccounts?.nodes,
      result.data?.order,
    );

    return cors(
      Response.json({
        credits,
        savedAmount,
        earnedCredit,
        firstName: getCustomerFirstName(customer),
        isCustomerInSystem: Boolean(customer),
        isMembershipCustomer: Boolean(appstleLoyalty),
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

function parseFirstAppstleLoyalty(...values) {
  for (const value of values) {
    const loyalty = parseAppstleLoyalty(value);
    if (loyalty) return loyalty;
  }
  return null;
}

function parseAppstleLoyalty(value) {
  if (!value) {
    return null;
  }

  try {
    const loyalty = JSON.parse(value);

    if (!loyalty || typeof loyalty !== "object") {
      return null;
    }

    const storeCreditBalance = Number(loyalty?.storeCreditBalance);
    const hasBalance = Number.isFinite(storeCreditBalance);
    const isEnrolled = "customerStatus" in loyalty;

    if (!hasBalance && !isEnrolled) {
      return null;
    }

    return {
      ...loyalty,
      storeCreditBalance: hasBalance ? storeCreditBalance : 0,
    };
  } catch {
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

function getLatestCredits(
  loyalty,
  storeCreditAccounts,
  shopCurrencyCode,
  currentOrder,
  savedAmount,
) {
  const nativeCredits =
    storeCreditAccounts
      ?.map((account) => account.balance)
      ?.filter((balance) => Number(balance.amount) > 0) || [];

  const appstleCredits = getAppstleCredits(loyalty, shopCurrencyCode);

  if (!appstleCredits.length) {
    return nativeCredits;
  }

  const appstleCredit = appstleCredits[0];
  const shopCurrencyCredit = nativeCredits.find(
    (credit) => credit.currencyCode === appstleCredit.currencyCode,
  );

  if (!shopCurrencyCredit) {
    return [
      ...nativeCredits,
      addPendingOrderCredit(appstleCredit, loyalty, currentOrder, savedAmount),
    ];
  }

  return nativeCredits.map((credit) =>
    credit === shopCurrencyCredit &&
    Number(appstleCredit.amount) === Number(shopCurrencyCredit.amount)
      ? addPendingOrderCredit(credit, loyalty, currentOrder, savedAmount)
      : credit,
  );
}

function getAppstleCredits(loyalty, currencyCode) {
  const amount = Number(loyalty?.storeCreditBalance);

  if (!Number.isFinite(amount) || amount <= 0 || !currencyCode) {
    return [];
  }

  return [{amount, currencyCode}];
}

function addPendingOrderCredit(credit, loyalty, currentOrder, savedAmount) {
  if (!isCurrentOrderPendingInAppstle(loyalty, currentOrder)) {
    return credit;
  }

  const orderSubtotal = currentOrder?.subtotalPriceSet?.shopMoney;

  if (orderSubtotal?.currencyCode !== credit.currencyCode) {
    return credit;
  }

  const earnedAmount = Math.round(Number(orderSubtotal.amount)) / 100;

  if (!Number.isFinite(earnedAmount) || earnedAmount <= 0) {
    return credit;
  }

  return {
    ...credit,
    amount: roundMoney(
      Math.max(Number(credit.amount) - Number(savedAmount?.amount || 0), 0) +
        earnedAmount,
    ),
  };
}

function getCurrentOrderEarnedCredit(loyalty, storeCreditAccounts, currentOrder) {
  const isEnrolled = Boolean(loyalty) || Boolean(storeCreditAccounts?.length);
  if (!isEnrolled) {
    return null;
  }

  const orderSubtotal = currentOrder?.subtotalPriceSet?.shopMoney;
  const subtotalAmount = Number(orderSubtotal?.amount);

  if (
    !Number.isFinite(subtotalAmount) ||
    subtotalAmount <= 0 ||
    !orderSubtotal?.currencyCode
  ) {
    return null;
  }

  return {
    amount: roundMoney(subtotalAmount * 0.01),
    currencyCode: orderSubtotal.currencyCode,
  };
}

function isCurrentOrderPendingInAppstle(loyalty, currentOrder) {
  const loyaltyActivityDate = Date.parse(loyalty?.lastActivityDate);
  const orderCreatedAt = Date.parse(currentOrder?.createdAt);

  return (
    Number.isFinite(loyaltyActivityDate) &&
    Number.isFinite(orderCreatedAt) &&
    loyaltyActivityDate < orderCreatedAt
  );
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
