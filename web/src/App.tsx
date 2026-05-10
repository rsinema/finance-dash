import { Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Transactions } from "./pages/Transactions";
import { Review } from "./pages/Review";
import { Settings } from "./pages/Settings";
import { Ask } from "./pages/Ask";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="transactions" element={<Transactions />} />
        <Route path="review" element={<Review />} />
        <Route path="ask" element={<Ask />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
