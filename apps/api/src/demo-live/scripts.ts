/**
 * Synthetic customer conversations and call transcripts for the live demo feed. Prices and names match the demo seed
 * (scripts/seed-industry-demos.ts). Every line is clearly demo content; nothing here is sent to anyone.
 */
export type Turn = ['user' | 'assistant', string];
export type ChatScript = {
  turns: Turn[];
  /** Conversation state after this exchange. */
  status?: 'active' | 'human_handoff' | 'closed';
  /** Lead status to set (or create the lead at). */
  lead?: string;
  /** A person must pick this up (shown under handoffs / escalations). */
  handoff?: string;
  /** Industry-specific lead fields. */
  leadExtra?: Record<string, unknown>;
};
export type CallScript = { outcome: string; summary: string; lines: Turn[]; leadStatus?: string };

export const CHATS: Record<string, ChatScript[]> = {
  real_estate: [
    { turns: [['user', 'Hi, looking for a 2 BHK in Porur under 80 lakhs'], ['assistant', 'Green Valley Residency in Porur has 2 BHK apartments from ₹78 L. Would you like to visit this weekend?'], ['user', 'Sunday morning is fine'], ['assistant', 'Noted: Sunday morning at Green Valley Residency. Our sales team will confirm the exact time shortly.']], lead: 'property_interested', leadExtra: { location: 'Porur', bhk: 2, propertyType: 'apartment', budget: 8000000 } },
    { turns: [['user', 'Any 3 BHK villas in Tambaram?'], ['assistant', 'Tambaram Garden Villas has 3 BHK villas at ₹98 L. Shall I share the brochure and book a site visit?'], ['user', 'Send brochure first']], lead: 'contacted', leadExtra: { location: 'Tambaram', bhk: 3, propertyType: 'villa', budget: 10000000 } },
    { turns: [['user', 'Plots near Guduvanchery price?'], ['assistant', 'Guduvanchery Plots Phase 2 starts at ₹35 L for a 1,200 sq ft plot. Do you want a site visit?'], ['user', 'yes saturday 4pm'], ['assistant', 'Requested: Saturday 4:00 PM at Guduvanchery Plots Phase 2. We will send the location the day before.']], lead: 'site_visit', leadExtra: { location: 'Guduvanchery', propertyType: 'plot', budget: 3500000 } },
    { turns: [['user', 'I want to talk to someone about loan options'], ['assistant', 'Sure — a team member will call you shortly about home-loan options.']], status: 'human_handoff', handoff: 'Customer asked about home-loan options', lead: 'qualified' },
    { turns: [['user', 'OMR la 2 BHK irukka? budget 70 L'], ['assistant', 'OMR Smart Homes-la 2 BHK ₹69 L-la irukku. Site visit book pannalama?'], ['user', 'next week paakalam']], lead: 'contacted', leadExtra: { location: 'OMR', bhk: 2, budget: 7000000 } },
  ],
  textile: [
    { turns: [['user', 'Need 300 cotton formal shirts for our office staff, sizes M and L'], ['assistant', 'Thank you! Noted: Cotton Formal Shirt, 300 pieces, sizes M / L. Approved price ₹650 per piece. I have created a quotation request; our sales team will send it shortly.']], lead: 'qualified' },
    { turns: [['user', 'Kanchipuram silk saree maroon colour available?'], ['assistant', 'Yes — Kanchipuram Silk Saree in maroon, pure silk, ₹12,500. Would you like photos of the border designs?'], ['user', 'yes please']], lead: 'catalogue_shared' },
    { turns: [['user', 'Poplin fabric 500 metres white rate?'], ['assistant', 'Poplin Fabric (100% cotton, white) is ₹120 per metre; minimum order 100 metres. For 500 metres I have asked our team to prepare a quotation.']], lead: 'quotation_sent' },
    { turns: [['user', 'Where is my order? It was supposed to come yesterday'], ['assistant', 'Sorry for the delay. I have passed this to our dispatch team; a team member will update you here shortly.']], status: 'human_handoff', handoff: 'Order delivery delayed — customer waiting', lead: 'order_confirmed' },
    { turns: [['user', 'uniform kurtas 120 pieces beige'], ['assistant', 'Cotton Kurta in beige is ₹720 per piece, sizes S–XL. I have noted 120 pieces; our sales team will confirm the size split and send the quotation.']], lead: 'qualified' },
  ],
  retail: [
    { turns: [['user', 'Do you have the wireless earbuds in black?'], ['assistant', 'Yes, Wireless Earbuds in black are in stock at ₹1,999. Shall I reserve one for you?'], ['user', 'yes 2 pieces'], ['assistant', 'Reserved 2 × Wireless Earbuds (₹3,998). Our team will confirm the order and delivery time shortly.']], lead: 'order_confirmed' },
    { turns: [['user', 'Smart watch warranty?'], ['assistant', 'The Smart Watch (₹3,499) has a 1-year brand warranty. Would you like it delivered or pick it up from the store?']], lead: 'contacted' },
    { turns: [['user', '65W charger stock iruka?'], ['assistant', '65W Fast Charger (white) stock-la irukku, ₹1,499. Order panna confirm pannunga.']], lead: 'catalogue_shared' },
    { turns: [['user', 'My power bank stopped charging after a week'], ['assistant', 'I am sorry about that. I have passed this to our service team; a team member will reply here about a replacement.']], status: 'human_handoff', handoff: 'Product complaint: power bank not charging', lead: 'repeat_customer' },
  ],
  restaurant: [
    { turns: [['user', 'Rendu kg broiler curry cut venum'], ['assistant', '2 kg Broiler Chicken (Curry cut) — ₹440. Eppo pickup pannuveenga?'], ['user', '7 mani ku'], ['assistant', 'Seri. Payment cash-ah UPI-ah?'], ['user', 'UPI'], ['assistant', '✅ Order confirm aagiduchu. 7:00 PM ku ready-a irukkum.']], status: 'closed', lead: 'won' },
    { turns: [['user', 'நாட்டு கோழி இருக்கா?'], ['assistant', 'Country Chicken இருக்கு — ₹450 / kg (Curry cut, Biryani cut, Whole). எவ்வளவு வேணும்?'], ['user', '1 kg curry cut']], lead: 'contacted' },
    { turns: [['user', '1 kg boneless and 12 eggs'], ['assistant', '1 kg Boneless Chicken — ₹380, 12 Country Eggs — ₹144. Total ₹524. Pickup time?'], ['user', '6:30'], ['assistant', '✅ Order confirm aagiduchu. 6:30 PM ku ready-a irukkum.']], status: 'closed', lead: 'won' },
    { turns: [['user', 'ennaku staff kitta pesanum'], ['assistant', 'Seri, engal staff seekiram inga reply pannuvaanga.']], status: 'human_handoff', handoff: 'Customer asked for a person', lead: 'contacted' },
  ],
  food: [
    { turns: [['user', 'Hi, 2 masala dosa and 1 filter coffee'], ['assistant', 'Which size for Filter Coffee? 1. Regular ₹35 / 2. Large ₹50'], ['user', 'regular'], ['assistant', '• 2 × Masala Dosa — ₹180\n• 1 × Filter Coffee (Regular) — ₹35\nSubtotal ₹215 · Tax ₹10.75 · Packing ₹15\n*Total ₹240.75*\nReply PICKUP or DELIVERY.'], ['user', 'pickup'], ['assistant', '✅ Order placed! Ready for pickup in about 20 minutes.']], status: 'closed', lead: 'won' },
    { turns: [['user', 'chicken biryani full and 2 rose milk delivery to anna nagar'], ['assistant', '• 1 × Chicken Biryani (Full) — ₹249\n• 2 × Rose Milk — ₹138\nDelivery to Anna Nagar (₹30, ~30 min). Please share the full address.'], ['user', '12, 4th Avenue, Anna Nagar'], ['assistant', '✅ Order placed! Expected delivery in about 45 minutes.']], status: 'closed', lead: 'won' },
    { turns: [['user', 'is mutton biryani available today?'], ['assistant', 'Sorry, Mutton Biryani is not available today; try Chicken Biryani (₹179 / ₹249) or Veg Biryani.']], lead: 'contacted' },
    { turns: [['user', 'My order came cold'], ['assistant', 'I am sorry about that. I have passed this to our restaurant team right away; a team member will reply here shortly.']], status: 'human_handoff', handoff: 'Complaint — "food arrived cold"', lead: 'won' },
  ],
  hotel: [
    { turns: [['user', 'Room available this Friday for 2 adults, 2 nights?'], ['assistant', 'Available Fri → Sun (2 nights), 2 adults:\n1. *Standard Room* — from ₹3,200 / night\n2. *Deluxe Room* — from ₹4,500 / night (breakfast)\nReply with the number to choose a room.'], ['user', '2'], ['assistant', '📝 Booking request received — our front desk will confirm it shortly. A 20% deposit is required; payment details will be shared by our team.']], lead: 'won' },
    { turns: [['user', 'Is airport pickup available?'], ['assistant', 'Airport pickup is available for ₹1,200 one way; request it here and the front desk will confirm.']], lead: 'contacted' },
    { turns: [['user', 'What time is check-in?'], ['assistant', 'Check-in is from 2:00 PM and check-out by 11:00 AM. Early check-in is subject to availability.']], status: 'closed', lead: 'contacted' },
    { turns: [['user', 'The TV in my room is not working'], ['assistant', 'I am sorry about this. I have alerted our front desk; a team member will help you right away.']], status: 'human_handoff', handoff: 'Guest service: TV not working in room', lead: 'won' },
  ],
  hospital: [
    { turns: [['user', 'I want to see a cardiologist'], ['assistant', 'Next available:\n1. Dr. Meera Krishnan — 10:00 am\n2. Dr. Vikram Iyer — 4:00 pm\nReply with the number.'], ['user', '1'], ['assistant', '✅ Appointment booked with Dr. Meera Krishnan (Cardiology). Please arrive 15 minutes early with any previous reports.']], status: 'closed', lead: 'won' },
    { turns: [['user', 'Child vaccination timings?'], ['assistant', 'Dr. Fathima Begum (Paediatrics) sees patients 10 AM – 1 PM and 5 – 7 PM, Monday to Saturday. Shall I book a slot?']], lead: 'contacted' },
    { turns: [['user', 'Do you accept Star Health cashless?'], ['assistant', 'Yes, we work with Star Health. Our insurance desk will help with pre-authorisation; please bring your insurance card and photo ID.']], lead: 'contacted' },
    { turns: [['user', 'My mother has high fever since morning'], ['assistant', '⚠️ If this is an emergency, please call 108 or come to our Emergency department immediately. I have alerted our team to call you back now.']], status: 'human_handoff', handoff: 'Escalation: high fever — call back now', lead: 'contacted' },
    { turns: [['user', 'knee pain ku doctor venum'], ['assistant', 'Dr. Arjun Rao (Orthopaedics) is available 9:30 AM – 12:30 PM. Booking pannalama?'], ['user', 'yes'], ['assistant', '✅ Appointment booked with Dr. Arjun Rao (Orthopaedics). Reminder anuppuvom.']], status: 'closed', lead: 'won' },
  ],
  manufacturing: [
    { turns: [['user', 'Batch of brass fittings received with thread damage, 25 pieces'], ['assistant', 'Thank you for reporting this. A member of our quality team will reply to you here shortly.']], status: 'human_handoff', handoff: 'Customer complaint: thread damage on brass fittings', lead: 'human_handoff' },
    { turns: [['user', 'Can you share the inspection report for our last order?'], ['assistant', 'Thank you for contacting Demo · Precision Components. Our quality team will share the report here shortly.']], lead: 'contacted' },
    { turns: [['user', 'Need 5000 rubber gaskets 40mm next month'], ['assistant', 'Thank you! Our sales team will confirm the delivery schedule and price shortly.']], lead: 'new' },
  ],
  agency: [
    { turns: [['user', 'We need Meta lead ads for our boutique, what are your packages?'], ['assistant', 'Thank you for contacting Demo · BrightLeaf Marketing. A strategist will share our packages here shortly.']], lead: 'contacted', leadExtra: { campaign: 'Diwali Boutique Promo', notes: 'Boutique: Meta lead ads for Diwali' } },
    { turns: [['user', 'Can you build a WhatsApp booking flow for my clinic?'], ['assistant', 'Yes — we set up WhatsApp booking flows for clinics. A team member will call you to understand your schedule.']], lead: 'qualified', leadExtra: { campaign: 'Clinic Lead Gen', notes: 'Clinic: WhatsApp booking flow' } },
    { turns: [['user', 'What will Google Ads cost for a restaurant?'], ['assistant', 'It depends on your area and goals; we usually start with a ₹15,000 monthly test budget. Our team will send a proposal.']], lead: 'contacted', leadExtra: { campaign: 'Restaurant Footfall', notes: 'Restaurant: Google Ads proposal' } },
    { turns: [['user', 'Please call me about the SEO retainer'], ['assistant', 'Sure — a team member will call you shortly.']], status: 'human_handoff', handoff: 'Wants a call about the SEO retainer', lead: 'qualified' },
  ],
};

export const CALLS: Record<string, CallScript[]> = {
  real_estate: [
    { outcome: 'site_visit_booked', summary: 'Booked a site visit at Green Valley Residency for Saturday 11 AM.', leadStatus: 'site_visit', lines: [['assistant', 'Vanakkam! This is the Tacksharp property assistant. You enquired about 2 BHK homes in Porur — is this a good time?'], ['user', 'Yes, tell me'], ['assistant', 'Green Valley Residency has 2 BHK homes from ₹78 lakh. Would you like to visit this Saturday?'], ['user', 'Saturday 11 is fine'], ['assistant', 'Booked for Saturday 11 AM. We will send the location on WhatsApp.']] },
    { outcome: 'callback_requested', summary: 'Customer was driving and asked for a call back in the evening.', lines: [['assistant', 'Hello, calling about your property enquiry in OMR.'], ['user', 'I am driving, call me after 6'], ['assistant', 'Sure, I will call you after 6 PM.']] },
    { outcome: 'qualified', summary: 'Budget ₹1.2 Cr, 3 BHK in Velachery, ready to move in within 6 months.', leadStatus: 'qualified', lines: [['assistant', 'Hi, you were looking at homes in Velachery. What size and budget?'], ['user', '3 BHK, around 1.2 crore'], ['assistant', 'Lakeview Towers fits that. When do you plan to move?'], ['user', 'Within six months']] },
    { outcome: 'not_interested', summary: 'Already bought elsewhere; follow-ups stopped.', leadStatus: 'not_interested', lines: [['assistant', 'Hello, following up on your enquiry for Tambaram villas.'], ['user', 'We already bought a house, thanks']] },
  ],
  textile: [
    { outcome: 'qualified', summary: 'Needs 200 uniform shirts by month end; quotation requested.', leadStatus: 'qualified', lines: [['assistant', 'Vanakkam, calling from the demo textile store about your uniform enquiry.'], ['user', 'Yes, we need 200 shirts'], ['assistant', 'Which colour and by when?'], ['user', 'Light blue, before the 30th']] },
    { outcome: 'callback_requested', summary: 'Asked for a call back tomorrow morning.', lines: [['assistant', 'Hello, about the silk saree catalogue you asked for.'], ['user', 'Call tomorrow morning please']] },
    { outcome: 'interested', summary: 'Interested in poplin fabric; wants samples.', lines: [['assistant', 'Hi, you enquired about poplin fabric.'], ['user', 'Can you send samples?'], ['assistant', 'Yes, I have noted it for our sales team.']] },
  ],
  restaurant: [
    { outcome: 'qualified', summary: 'Phone order: 1.5 kg broiler curry cut, pickup 7 PM.', lines: [['user', 'Ondra kilo broiler curry cut'], ['assistant', '1.5 kg Broiler Chicken (Curry cut) — ₹330. Pickup time?'], ['user', '7 mani'], ['assistant', 'Seri, 7 mani ku ready-a irukkum.']] },
    { outcome: 'connected', summary: 'Asked whether country chicken is available.', lines: [['user', 'Nattu kozhi irukka?'], ['assistant', 'Irukku, ₹450 per kg.']] },
  ],
  food: [
    { outcome: 'qualified', summary: 'Phone order: 2 Veg Fried Rice and 1 Gobi Manchurian for pickup.', lines: [['user', 'Two veg fried rice and one gobi manchurian'], ['assistant', 'That is ₹470 plus tax. Pickup or delivery?'], ['user', 'Pickup']] },
    { outcome: 'connected', summary: 'Asked for the status of a delivery order.', lines: [['user', 'Where is my order?'], ['assistant', 'It is out for delivery and should reach you in about 10 minutes.']] },
  ],
  hotel: [
    { outcome: 'qualified', summary: 'Pre-arrival call: guest confirmed arrival at 3 PM and requested a high floor.', lines: [['assistant', 'Good afternoon, calling from the demo hotel about your stay tomorrow.'], ['user', 'Yes, we arrive around 3'], ['assistant', 'Noted. Any requests?'], ['user', 'High floor if possible']] },
    { outcome: 'callback_requested', summary: 'Guest asked to be called back about the deposit.', lines: [['assistant', 'Hello, about your booking request.'], ['user', 'Call me later about the deposit']] },
  ],
  hospital: [
    { outcome: 'qualified', summary: 'Reminder call: patient confirmed tomorrow\'s appointment.', lines: [['assistant', 'Vanakkam, this is a reminder for your appointment tomorrow.'], ['user', 'Yes, I will come'], ['assistant', 'Please bring your previous reports.']] },
    { outcome: 'callback_requested', summary: 'Campaign lead asked for a call back after 5 PM.', lines: [['assistant', 'Hello, you registered for the free heart check-up camp.'], ['user', 'Call after 5 please']] },
  ],
};

/** Pipeline for lead progress per industry (status → next). */
export const LEAD_NEXT: Record<string, Record<string, string>> = {
  real_estate: { new: 'contacted', contacted: 'qualified', qualified: 'property_interested', property_interested: 'site_visit', site_visit: 'won' },
  textile: { new: 'contacted', contacted: 'qualified', qualified: 'catalogue_shared', catalogue_shared: 'quotation_sent', quotation_sent: 'order_confirmed', order_confirmed: 'repeat_customer' },
  retail: { new: 'contacted', contacted: 'catalogue_shared', catalogue_shared: 'order_confirmed', order_confirmed: 'repeat_customer' },
  restaurant: { new: 'contacted', contacted: 'won' },
  food: { new: 'contacted', contacted: 'won' },
  hotel: { new: 'contacted', contacted: 'won' },
  hospital: { new: 'contacted', contacted: 'won' },
  manufacturing: { new: 'contacted' },
  agency: { new: 'contacted', contacted: 'qualified', qualified: 'won' },
};

export const FOLLOW_UP_STEP: Record<string, { source: string; message: string }> = {
  real_estate: { source: 'sequence', message: 'reminder' },
  textile: { source: 'quote', message: 'quote:reminder:demo' },
  retail: { source: 'order', message: 'order:status:demo:dispatched' },
  restaurant: { source: 'sequence', message: 'missed_call' },
  food: { source: 'food', message: 'food:feedback:demo' },
  hotel: { source: 'booking', message: 'booking:pre_arrival:demo' },
  hospital: { source: 'appointment', message: 'appointment:reminder:demo:0' },
  manufacturing: { source: 'manual', message: 'complaint_update' },
  agency: { source: 'manual', message: 'proposal_followup' },
};

export const NAMES = ['Ravi Kumar', 'Meena S', 'Karthik R', 'Lakshmi N', 'Senthil M', 'Priya V', 'Arun P', 'Divya K', 'Gopal R', 'Revathi K', 'Suresh B', 'Anitha P', 'Bala S', 'Nandhini V', 'Mohammed F', 'Deepa N', 'Vignesh T', 'Kavitha R', 'Rajesh I', 'Sangeetha M', 'Hari K', 'Janani S', 'Prakash R', 'Yamuna D', 'Dinesh K', 'Shalini G', 'Ashwin V', 'Bhuvana R', 'Farhan A', 'Ishwarya M', 'Joseph P', 'Keerthana S', 'Lokesh B', 'Mahalakshmi T', 'Naveen C', 'Oviya R', 'Pandian K', 'Ramya J', 'Sathya N', 'Tamilselvi E', 'Abdul R', 'Bharathi K', 'Chitra V', 'Durai M', 'Elango P', 'Gayathri S', 'Harini B', 'Indhu R'];
