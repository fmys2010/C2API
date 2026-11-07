import email
from email.message import EmailMessage
import unittest
from unittest.mock import MagicMock, patch

from services.register.mail_provider import (
    GmailMailProvider,
    GenericImapMailProvider,
    _extract_otp_code,
    _is_recipient_match,
    create_mail_provider,
)


class TestGmailMailProvider(unittest.TestCase):
    def test_app_password_whitespace_removal(self):
        provider = GmailMailProvider(
            gmail_address="user@gmail.com",
            gmail_app_password=" abcd  efgh ijkl mnop \n",
            domains="nomorera2.de, mx1.nomorera2.de",
        )
        self.assertEqual(provider.gmail_app_password, "abcdefghijklmnop")
        self.assertEqual(provider.domains, ["nomorera2.de", "mx1.nomorera2.de"])

    def test_create_email_with_custom_domains(self):
        provider = GmailMailProvider(
            gmail_address="user@gmail.com",
            gmail_app_password="abcdefghijklmnop",
            domains="nomorera2.de, mx1.nomorera2.de",
        )
        email_addr, token = provider.create_email()
        self.assertIsNotNone(email_addr)
        self.assertTrue(email_addr.endswith("@nomorera2.de") or email_addr.endswith("@mx1.nomorera2.de"))
        self.assertEqual(email_addr, token)

    def test_create_email_fallback_plus_addressing(self):
        provider = GmailMailProvider(
            gmail_address="mytest@gmail.com",
            gmail_app_password="abcdefghijklmnop",
            domains="",
        )
        email_addr, token = provider.create_email()
        self.assertIsNotNone(email_addr)
        self.assertTrue(email_addr.startswith("mytest+"))
        self.assertTrue(email_addr.endswith("@gmail.com"))

    def test_recipient_matching_headers(self):
        # 1. Matches To
        msg1 = EmailMessage()
        msg1["To"] = "target123@nomorera2.de"
        msg1["Subject"] = "Your ChatGPT verification code"
        msg1.set_content("Your code is 654321")
        self.assertTrue(_is_recipient_match(msg1, "target123@nomorera2.de"))
        self.assertFalse(_is_recipient_match(msg1, "other@nomorera2.de"))

        # 2. Matches Delivered-To / X-Forwarded-To (Cloudflare Email Routing)
        msg2 = EmailMessage()
        msg2["To"] = "user@gmail.com"
        msg2["Delivered-To"] = "target456@nomorera2.de"
        msg2["Subject"] = "Your ChatGPT verification code"
        msg2.set_content("Your code is 654321")
        self.assertTrue(_is_recipient_match(msg2, "target456@nomorera2.de"))

        # 3. Matches in Body text
        msg3 = EmailMessage()
        msg3["To"] = "user@gmail.com"
        msg3["Subject"] = "OpenAI verification"
        msg3.set_content("Verification code for target789@nomorera2.de is 112233")
        self.assertTrue(_is_recipient_match(msg3, "target789@nomorera2.de"))

    def test_otp_extraction(self):
        text1 = "Your ChatGPT code is 987654. Do not share this code."
        self.assertEqual(_extract_otp_code(text1), "987654")

        text2 = "<div>Your OpenAI code is: 123456</div>"
        self.assertEqual(_extract_otp_code(text2), "123456")

        text3 = "verification code to continue: 554433"
        self.assertEqual(_extract_otp_code(text3), "554433")

    def test_get_code_deletes_and_expunges_matching_email(self):
        provider = GmailMailProvider(
            gmail_address="user@gmail.com",
            gmail_app_password="abcdefghijklmnop",
            domains="nomorera2.de",
        )

        target_email = "victim99@nomorera2.de"
        msg = EmailMessage()
        msg["To"] = target_email
        msg["Subject"] = "Your OpenAI code is 432109"
        msg.set_content("Hello, your code is 432109")
        raw_bytes = msg.as_bytes()

        mock_client = MagicMock()
        mock_client.search.return_value = ("OK", [b"1 2"])
        # num 2 is our message
        mock_client.fetch.return_value = ("OK", [(b"2 (RFC822 {100})", raw_bytes)])

        with patch.object(provider, "_connect_imap", return_value=mock_client):
            code = provider.get_code(target_email, timeout=2, poll_interval=1)

        self.assertEqual(code, "432109")
        # Verify message was marked \\Deleted
        mock_client.store.assert_called_with(b"2", "+FLAGS", "\\Deleted")
        # Verify expunge was called
        mock_client.expunge.assert_called_once()

    def test_create_mail_provider_factory(self):
        cfg_gmail = {
            "mail_mode": "gmail",
            "gmail_address": "test@gmail.com",
            "gmail_app_password": "pass",
            "domains": "test.com",
        }
        prov = create_mail_provider(cfg_gmail)
        self.assertIsInstance(prov, GmailMailProvider)

        cfg_imap = {
            "mail_mode": "imap",
            "imap_host": "imap.example.com",
            "imap_username": "user",
            "imap_password": "pwd",
        }
        prov_imap = create_mail_provider(cfg_imap)
        self.assertIsInstance(prov_imap, GenericImapMailProvider)


if __name__ == "__main__":
    unittest.main()
