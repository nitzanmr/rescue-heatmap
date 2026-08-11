import MyReport from "./MyReport";

export const metadata = {
  title: "Mi reporte",
  robots: { index: false, follow: false },
};

export default async function Page({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  return <MyReport reference={decodeURIComponent(ref).toUpperCase()} />;
}
