# Rescue Node — Local Offline Intake Point

**Status:** design proposal. Not implemented. Complements [offline-first-options.md](offline-first-options.md) (this is Option 6 there).

**One-line thesis:** the hard case is not "the network is slow" — it is *"this person never loaded our app and has no connectivity at all."* A QR code pointing at a website is useless to them. A **local node broadcasting its own Wi-Fi and serving the form itself** is the only design that reaches them.

---

## 1. Reframing the connectivity assumption

Post-earthquake connectivity is almost never binary. The realistic picture:

- some cell sites stay up but are **saturated** by call/data surges
- **power** failures progressively kill towers, routers and home equipment as batteries drain (hours → days)
- coverage is **block-by-block**: one neighbourhood works, the next has nothing
- **SMS/signalling often survives when data does not** — a smaller payload on a less congested path
- responders later introduce **satellite backhaul and temporary Wi-Fi** (e.g. ETC Cluster), creating islands of connectivity around relief points

Design consequence: build **layers**, not a single online/offline switch.

---

## 2. Layered fallback model

| Situation | Channel |
|---|---|
| Internet available | Normal HTTPS form |
| Internet poor / intermittent | Offline PWA — queues locally, syncs later |
| No internet, relief point nearby | **Rescue Node** — local Wi-Fi + captive portal |
| No data, but cellular signalling works | SMS reporting template |
| Field teams | Encrypted store-and-forward app + satellite-connected sync node |

Every layer writes into the **same normalized report schema with deduplication at intake**.

---

## 3. Rescue Node — how it works

1. A laptop, Raspberry Pi, travel router or dedicated phone creates a **local Wi-Fi hotspot** (no internet required).
2. Posters at the relief point show a QR to **join that Wi-Fi**, plus a printed SSID and a short local address (e.g. `missing.local` / `http://192.168.4.1`).
3. A **captive portal** opens the reporting form directly from the node — nothing is fetched from the internet.
4. Submissions are **encrypted and stored on the node**, with an immediate on-screen **receipt number**.
5. When the node later gets cellular, satellite or wired connectivity, it **store-and-forwards** the queued reports to the central database.
6. Every report carries a **UUID + incident ID + timestamp + sync state**, so retries never create duplicates.

### Why this is the core architecture
It is the only option that works for someone who installed nothing before the earthquake. An ordinary offline PWA does not — it requires one successful load.

---

## 4. Companion: PWA for phones that *did* load the app

For users who reached the site before losing service:

- cache form, assets and translations with a **service worker**
- store drafts and submissions in **IndexedDB**
- show an unambiguous state: **"Saved on this device — not transmitted yet"**
- retry automatically when connectivity returns
- **always include a manual "Send now" button** — background sync is unreliable, and effectively absent on iPhone

---

## 5. QR reality check

A single universal QR code generally **cannot** both join a Wi-Fi network and open a page across Android and iOS.

**Use two adjacent QR codes on every poster:**

```
1. Join "Rescue Wi-Fi"      2. Open the missing-person form
   [QR]                        [QR]
   SSID: RESCUE-<site>         http://192.168.4.1
```

Always print the SSID and the short URL as a human-readable fallback — QR scanning fails in bad light, with cracked screens, and for older users.

---

## 6. Android-phone variant (emergency fallback)

A responder Android phone can itself be the node: enable hotspot → run a small local web server bundling the form → nearby phones join → submit to `http://192.168.x.1` → encrypted local storage → upload when the responder later reaches the internet.

**Practical setup**
- a **dedicated** phone, never a volunteer's personal device
- native app bundling the form + local server, running as a **foreground service**
- two QR codes (join / open), plus printed fallback
- large power bank or solar charger
- visible offline status and a submission receipt number
- encrypted local DB, access PIN, remote-wipe procedure, automatic deletion after successful sync

**Limitations — treat as fallback, not production**
- **iPhone cannot host this**: iOS heavily restricts background servers and captive-portal behaviour
- Android may kill the server for battery unless it is a foreground service
- hotspot IP ranges vary by device → the app must **detect and display** its current address
- `.local` names and captive-portal detection are inconsistent across devices
- a phone hotspot realistically covers **tens of metres and ~10–20 reliable users**
- if the host phone dies, is stolen or is lost, **unsynced reports are lost** → sync early, sync often
- plain HTTP is acceptable **only** on the isolated local network, with clear safeguards; HTTPS certs for local addresses are awkward

---

## 7. Recommended path

| Stage | Node hardware |
|---|---|
| MVP / drill | Dedicated Android phone + native "Rescue Node" app |
| Real deployment | Small travel router or Raspberry Pi + battery; phone used only for admin/backhaul |
| Multi-site | Each node stores independently, then store-and-forward sync; central dedup across nodes |

**Product framing:** the deliverable is not "a QR form" — it is a **portable offline Rescue Node** that happens to be able to run on an Android phone.

---

## 8. Open questions

- [ ] Which hardware do we standardise on for a go-bag kit, and who holds it?
- [ ] Node identity/authentication: how does the central DB trust a node's batch upload?
- [ ] Data protection: what is the lawful basis and retention rule for reports resting on a node?
- [ ] How do we prevent cross-node duplicates when families report at several relief points?
- [ ] Can we piggyback on ETC Cluster / responder Wi-Fi instead of providing backhaul ourselves?
