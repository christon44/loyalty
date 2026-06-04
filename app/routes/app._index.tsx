import type {HeadersFunction, LoaderFunctionArgs} from "react-router";
import {authenticate} from "../shopify.server";
import {boundary} from "@shopify/shopify-app-react-router/server";

export const loader = async ({request}: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {
  return (
    <s-page heading="Store Credit Reminder">
      <s-section heading="Checkout extension is installed">
        <s-paragraph>
          Your app is set up to show customer store credit on the Thank you page.
        </s-paragraph>
        <s-paragraph>
          Go to Shopify Admin, open Checkout customization, and add the
          Store-Credit-Reminder block to the Thank you page.
        </s-paragraph>
      </s-section>

      <s-section heading="Required access">
        <s-unordered-list>
          <s-list-item>read_orders</s-list-item>
          <s-list-item>read_customers</s-list-item>
          <s-list-item>read_store_credit_accounts</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Next test">
        <s-paragraph>
          Place a test order as a logged-in customer that has store credit.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};