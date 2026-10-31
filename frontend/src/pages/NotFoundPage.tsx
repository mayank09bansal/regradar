import { Link } from "react-router-dom";
import { EmptyState, PageHeader } from "../components/ui";

export default function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <EmptyState title="There is nothing at this address">
        <p><Link to="/">Back to the dashboard</Link></p>
      </EmptyState>
    </>
  );
}
