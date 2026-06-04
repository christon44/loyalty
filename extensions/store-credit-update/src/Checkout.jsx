import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useEffect, useState} from "preact/hooks";

const APP_URL = "https://credit.apps.tmgindustrial.com";
const ACCOUNT_LOGIN_URL =
  "https://shopify.com/authentication/80657907968/login?client_id=701f89ba-7af7-4192-a741-47abf7a424c9&locale=en&redirect_uri=%2Fauthentication%2F80657907968%2Foauth%2Fauthorize%3F_cs%3D%26buyer_flags%3DeyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiIxMjM0LTEyMzQ1Njc4OTAxMjM0NTY4MDM5Lm15c2hvcGlmeS5jb20iLCJmbGFncyI6W10sImV4cCI6MTc4MTEyMTE1NiwibmJmIjoxNzgwNTE2MzU2fQ.tBVB9V0riZQ5Qs-VfwUEk-CLTA6Vph9cdtPgS9N3vZQ%26client_id%3D701f89ba-7af7-4192-a741-47abf7a424c9%26locale%3Den%26nonce%3D6376b649-fdc6-41c1-911f-e068092321a7%26redirect_uri%3Dhttps%253A%252F%252F1234-12345678901234568039.myshopify.com%252Fcustomer_authentication%252Fcallback%26response_type%3Dcode%26scope%3Dopenid%2Bemail%2Bcustomer-account-api%253Afull%26state%3DhWNCvKrRo9zDRgp4H6i3xnI9&ui_hint=full";
const MEMBERSHIP_URL = "https://tmg-ca-test.myshopify.com/apps/loyalty";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const [status, setStatus] = useState("loading");
  const [message, setMessage] = useState("");
  const [credits, setCredits] = useState([]);
  const [savedAmount, setSavedAmount] = useState(null);
  const [earnedCredit, setEarnedCredit] = useState(null);
  const [firstName, setFirstName] = useState("");
  const [isCustomerInSystem, setIsCustomerInSystem] = useState(false);

  useEffect(() => {
    async function loadStoreCredit() {
      try {
        const orderId = shopify.orderConfirmation.value?.order?.id;

        if (!orderId) {
          setStatus("error");
          setMessage("No order ID found on this Thank you page.");
          return;
        }

        const token = await shopify.sessionToken.get();

        const response = await fetch(`${APP_URL}/api/store-credit`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({orderId}),
        });

        const data = await response.json();

        if (!response.ok) {
          setStatus("error");
          setMessage(data.error || "Store credit request failed.");
          return;
        }

        setCredits(data.credits || []);
        setSavedAmount(data.savedAmount || null);
        setEarnedCredit(data.earnedCredit || null);
        setFirstName(data.firstName || "");
        setIsCustomerInSystem(Boolean(data.isCustomerInSystem));
        setStatus("loaded");
      } catch (error) {
        if (error instanceof TypeError) {
          console.error("Unable to reach the TMG membership app", error);
          setCredits([]);
          setSavedAmount(null);
          setEarnedCredit(null);
          setStatus("loaded");
          return;
        }

        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Unknown error");
      }
    }

    loadStoreCredit();
  }, []);

  if (status === "loading") {
    return (
      <s-banner tone="info">
        <s-text>Checking your available store credit...</s-text>
      </s-banner>
    );
  }

  if (status === "error") {
    return (
      <s-banner tone="critical">
        <s-text>{message}</s-text>
      </s-banner>
    );
  }

  const availableCredits = credits.filter(
    (credit) => Number(credit.amount) > 0,
  );
  const hasStoreCreditActivity = Boolean(
    availableCredits.length || savedAmount || earnedCredit,
  );

  if (!hasStoreCreditActivity && isCustomerInSystem) {
    return (
      <NoticeBlock>
        <s-stack gap="base">
          <s-text type="strong">Membership Reminder!</s-text>
          <s-text>
            Hi{firstName ? ` ${firstName}` : ""}, you&apos;re already
            spending, why not earn rewards too?{" "}
            <s-link
              href={MEMBERSHIP_URL}
              target="_blank"
            >
              Join TMG Membership Program
            </s-link>{" "}
            and start earning store credits today.
          </s-text>
        </s-stack>
      </NoticeBlock>
    );
  }

  if (!hasStoreCreditActivity) {
    return (
      <NoticeBlock>
        <s-stack gap="base">
          <s-text type="strong">Membership Reminder!</s-text>
          <s-text>
            Hi{firstName ? ` ${firstName}` : ""}, you&apos;re already
            spending, why not earn rewards too?{" "}
            <s-link href={ACCOUNT_LOGIN_URL} target="_blank">
              SignUp to TMG Industrial to join Membership Program
            </s-link>{" "}
            and start earning store credits today.
          </s-text>
        </s-stack>
      </NoticeBlock>
    );
  }

  return (
    <NoticeBlock icon="celebration">
      <s-stack gap="base">
        <s-text type="strong">
          Congratulations{firstName ? ` ${firstName}!` : "!"}
        </s-text>
        {savedAmount ? (
          <s-text>
            You saved{" "}
            {shopify.i18n.formatCurrency(Number(savedAmount.amount), {
              currency: savedAmount.currencyCode,
            })}{" "}
            on this order.
          </s-text>
        ) : null}
        {earnedCredit ? (
          <s-text>
            You have earned{" "}
            {shopify.i18n.formatCurrency(Number(earnedCredit.amount), {
              currency: earnedCredit.currencyCode,
            })}{" "}
            store credits on this order.
          </s-text>
        ) : null}
        {availableCredits.map((credit) => (
          <s-stack key={credit.currencyCode} gap="small">
            <s-text>
              Credit balance you can use for your next purchase:{" "}
              {shopify.i18n.formatCurrency(Number(credit.amount), {
                currency: credit.currencyCode,
              })}
            </s-text>
            <s-text>Hope to see you soon!</s-text>
          </s-stack>
        ))}
      </s-stack>
    </NoticeBlock>
  );
}

// eslint-disable-next-line react/prop-types
function NoticeBlock({children, icon = "alert"}) {
  return (
    <s-box
      background="subdued"
      border="base"
      borderRadius="base"
      borderWidth="base base large-200 base"
      padding="large"
    >
      <s-grid
        gridTemplateColumns="auto 1fr"
        columnGap="base"
        alignItems="start"
      >
        {icon === "celebration" ? (
          <s-text>🎉</s-text>
        ) : (
          <s-icon type="alert-circle" tone="neutral" size="large" />
        )}
        <s-box>
          {children}
        </s-box>
      </s-grid>
    </s-box>
  );
}
