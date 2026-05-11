# =========================================================
# BYBIT P2P AUTO PAYMENT BOT + TELEGRAM CHANNEL NOTIFIER
# =========================================================
#
# FEATURES:
#
# ✅ Detects new P2P orders automatically
# ✅ Waits 20 seconds
# ✅ Sends first Bybit chat message
# ✅ Waits 5 seconds
# ✅ Attempts "Mark as Paid"
# ✅ If failed:
#       - DOES NOT send bank details
#       - waits 15 seconds
#       - retries automatically
# ✅ If successful:
#       - sends payment info to TELEGRAM CHANNEL
#       - includes COPY ACCOUNT NUMBER button
# ✅ Waits 10 seconds
# ✅ Sends final release message
# ✅ Added timeout + headers + SSL stability
# ✅ Fixed get_orders() parsing
#
# HOST FREE:
# https://render.com
#
# =========================================================
from flask import Flask
import requests
import time
import hmac
import hashlib
import json
import certifi
import os
import threading
import threading

app = Flask(__name__)

@app.route("/")
def home():
    return "Bot is running"

def run_web():
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)

threading.Thread(target=run_web).start()


def bot_loop():
    while True:
        print("BOT IS RUNNING")
        # your get_orders() logic here
        time.sleep(10)

# start bot thread
threading.Thread(target=bot_loop, daemon=True).start()
# =========================================================
# SSL FIX (IMPORTANT FOR RENDER/macOS)
# =========================================================

os.environ['SSL_CERT_FILE'] = certifi.where()

# =========================================================
# CONFIGURATION
# =========================================================

BYBIT_API_KEY = "7VqyeYqz0rpIvJZ09f"
BYBIT_API_SECRET = "LMsmjhD5w0I2bSsckDTrNMwSThqlzK9Xju3r"

TELEGRAM_BOT_TOKEN = "8719872027:AAHSUe220IlGvNtMDq6SIJrC6zxYn7IHcwk"

# Example: -1001234567890
TELEGRAM_CHANNEL_ID = "-1003821353028"

BASE_URL = "https://api.bybit.com"

HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Connection": "close"
}

# =========================================================
# TELEGRAM MESSAGE FUNCTION
# =========================================================

def send_telegram_message(text, account_number=None):

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"

    keyboard = None

    # =====================================================
    # COPY ACCOUNT BUTTON
    # =====================================================

    if account_number:

        keyboard = {
            "inline_keyboard": [
                [
                    {
                        "text": "📋 Copy Account Number",
                        "callback_data": f"copy_{account_number}"
                    }
                ]
            ]
        }

    data = {
        "chat_id": TELEGRAM_CHANNEL_ID,
        "text": text,
        "parse_mode": "HTML"
    }

    if keyboard:
        data["reply_markup"] = json.dumps(keyboard)

    try:

        response = requests.post(
            url,
            data=data,
            headers=HEADERS,
            timeout=20
        )

        print("Telegram Sent:", response.text)

    except Exception as e:

        print("Telegram Error:", e)

# =========================================================
# SIGNATURE GENERATOR
# =========================================================

def create_signature(params):

    param_str = "&".join(
        [f"{key}={params[key]}" for key in sorted(params)]
    )

    return hmac.new(
        BYBIT_API_SECRET.encode("utf-8"),
        param_str.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()

# =========================================================
# GET P2P ORDERS
# =========================================================

def get_orders():

    timestamp = str(int(time.time() * 1000))

    params = {
        "api_key": BYBIT_API_KEY,
        "timestamp": timestamp
    }

    params["sign"] = create_signature(params)

    url = BASE_URL + "/v5/p2p/order/list"

    # =====================================================
    # RETRY SYSTEM
    # =====================================================

    for attempt in range(3):

        try:

            response = requests.get(
                url,
                params=params,
                headers=HEADERS,
                timeout=40
            )

            print("ORDER STATUS:", response.status_code)
            print("ORDER RESPONSE:", response.text[:300])

            try:
                data = response.json()
            except:
                print("Invalid JSON response")
                time.sleep(5)
                continue

            # =================================================
            # CHECK API RESPONSE
            # =================================================

            if data.get("retCode") != 0:

                print("BYBIT API ERROR:", data)

                return []

            # =================================================
            # FIXED RESULT PARSING
            # =================================================

            return data.get("result", {}).get("list", [])

        except Exception as e:

            print(f"Get Orders Attempt {attempt+1}/3 Failed:", e)

            time.sleep(5)

    return []

# =========================================================
# SEND BYBIT CHAT MESSAGE
# =========================================================

def send_chat_message(order_id, message):

    timestamp = str(int(time.time() * 1000))

    params = {
        "api_key": BYBIT_API_KEY,
        "timestamp": timestamp,
        "orderId": order_id,
        "content": message
    }

    params["sign"] = create_signature(params)

    url = BASE_URL + "/v5/p2p/order/message/send"

    try:

        response = requests.post(
            url,
            json=params,
            headers=HEADERS,
            timeout=40
        )

        print("Chat Message:", response.text)

        try:
            data = response.json()

            return data.get("retCode") == 0

        except:
            return False

    except Exception as e:

        print("Chat Error:", e)

        return False

# =========================================================
# MARK ORDER AS PAID
# =========================================================

def mark_as_paid(order_id):

    timestamp = str(int(time.time() * 1000))

    params = {
        "api_key": BYBIT_API_KEY,
        "timestamp": timestamp,
        "orderId": order_id
    }

    params["sign"] = create_signature(params)

    url = BASE_URL + "/v5/p2p/order/pay"

    try:

        response = requests.post(
            url,
            json=params,
            headers=HEADERS,
            timeout=40
        )

        print("Paid Response:", response.text)

        try:
            data = response.json()
        except:
            return False

        # =================================================
        # SUCCESS CHECK
        # =================================================

        if data.get("retCode") == 0:
            return True

        return False

    except Exception as e:

        print("Mark Paid Error:", e)

        return False

# =========================================================
# EXTRACT ORDER DETAILS
# =========================================================

def extract_order(order):

    try:

        order_id = order.get("id", "N/A")

        usdt_amount = order.get("amount", "N/A")

        fiat_amount = order.get("totalPrice", "N/A")

        payment_info = order.get("paymentInfo", {})

        bank_name = payment_info.get("bankName", "N/A")

        account_name = payment_info.get("accountName", "N/A")

        account_number = payment_info.get("accountNo", "N/A")

        username = order.get("targetNickName", "N/A")

        text = f"""
🟢 <b>NEW P2P PAYMENT</b>

🆔 <b>Order ID:</b>
<code>{order_id}</code>

👤 <b>User:</b>
{username}

💵 <b>USDT:</b>
{usdt_amount}

💰 <b>Fiat Amount:</b>
{fiat_amount}

🏦 <b>Bank:</b>
{bank_name}

👤 <b>Account Name:</b>
<code>{account_name}</code>

🔢 <b>Account Number:</b>
<code>{account_number}</code>
"""

        return text, account_number, fiat_amount

    except Exception as e:

        print("Extract Error:", e)

        return None, None, None

# =========================================================
# MAIN LOOP
# =========================================================

processed_orders = []

while True:

    try:

        orders = get_orders()

        print("FOUND ORDERS:", len(orders))

        for order in orders:

            order_id = order.get("id")

            if not order_id:
                continue

            # =============================================
            # SKIP IF ALREADY PROCESSED
            # =============================================

            if order_id in processed_orders:
                continue

            processed_orders.append(order_id)

            print("NEW ORDER:", order_id)

            # =============================================
            # WAIT 20 SECONDS
            # =============================================

            time.sleep(20)

            # =============================================
            # FIRST MESSAGE
            # =============================================

            first_message = (
                "Kindly hold for payment. "
                "Payment will be made shortly. "
                "Please release immediately after confirmation."
            )

            first_sent = send_chat_message(
                order_id,
                first_message
            )

            print("FIRST MESSAGE SENT:", first_sent)

            # =============================================
            # WAIT 5 SECONDS
            # =============================================

            time.sleep(5)

            # =============================================
            # TRY MARK AS PAID
            # =============================================

            success = mark_as_paid(order_id)

            # =============================================
            # RETRY IF FAILED
            # =============================================

            if not success:

                print("FIRST PAID ATTEMPT FAILED")

                send_telegram_message(
                    f"⚠️ Failed to mark order as paid.\n\n"
                    f"Order ID: {order_id}\n"
                    f"Retrying in 15 seconds..."
                )

                time.sleep(15)

                success = mark_as_paid(order_id)

            # =============================================
            # FINAL FAILURE
            # =============================================

            if not success:

                send_telegram_message(
                    f"❌ Could not mark order as paid.\n\n"
                    f"Order ID: {order_id}\n"
                    f"Manual action required."
                )

                continue

            # =============================================
            # SUCCESS
            # =============================================

            print("ORDER MARKED AS PAID")

            # =============================================
            # EXTRACT INFO
            # =============================================

            text, account_number, fiat_amount = extract_order(order)

            # =============================================
            # SEND TO TELEGRAM CHANNEL
            # =============================================

            if text:

                send_telegram_message(
                    text,
                    account_number=account_number
                )

                print("PAYMENT INFO SENT")

            # =============================================
            # WAIT 10 SECONDS
            # =============================================

            time.sleep(10)

            # =============================================
            # FINAL MESSAGE
            # =============================================

            final_message = (
                f"Payment of {fiat_amount} has been completed successfully. "
                "Kindly confirm and release coin. "
                "Please leave a good review ❤️"
            )

            send_chat_message(
                order_id,
                final_message
            )

            print("FINAL MESSAGE SENT")

        # =============================================
        # CHECK EVERY 15 SECONDS
        # =============================================

        time.sleep(15)

    except Exception as main_error:

        print("MAIN LOOP ERROR:", main_error)

        time.sleep(10)
