package transport

import (
	"testing"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func ev(msg *waE2E.Message) *events.Message {
	return &events.Message{
		Info: types.MessageInfo{
			ID: "ID1",
			MessageSource: types.MessageSource{
				Chat:   types.NewJID("254712345678", types.DefaultUserServer),
				Sender: types.NewJID("254712345678", types.DefaultUserServer),
			},
		},
		Message: msg,
	}
}

func TestMapMessageKinds(t *testing.T) {
	cases := []struct {
		name string
		msg  *waE2E.Message
		want Kind
	}{
		{"text", &waE2E.Message{Conversation: proto.String("hi")}, KindText},
		{"extended", &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("hi")}}, KindText},
		{"image", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{FileLength: proto.Uint64(9)}}, KindImage},
		{"reaction", &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{}}, KindReaction},
		{"video", &waE2E.Message{VideoMessage: &waE2E.VideoMessage{}}, KindMedia},
		{"audio", &waE2E.Message{AudioMessage: &waE2E.AudioMessage{}}, KindMedia},
		{"document", &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{}}, KindMedia},
		{"sticker", &waE2E.Message{StickerMessage: &waE2E.StickerMessage{}}, KindMedia},
		{"empty", &waE2E.Message{}, KindOther},
	}
	for _, c := range cases {
		m := mapMessage(nil, ev(c.msg))
		if m.Kind != c.want {
			t.Errorf("%s: kind %d want %d", c.name, m.Kind, c.want)
		}
		if m.Sender != "254712345678" || m.ID != "ID1" {
			t.Errorf("%s: sender/id %q %q", c.name, m.Sender, m.ID)
		}
	}
}

func TestMapMessageEditAndLID(t *testing.T) {
	e := ev(&waE2E.Message{Conversation: proto.String("fixed")})
	e.Info.Edit = types.EditAttributeMessageEdit
	if mapMessage(nil, e).Kind != KindEdit {
		t.Error("edit attribute not detected")
	}
	e = ev(&waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{EditedMessage: &waE2E.Message{}}})
	if mapMessage(nil, e).Kind != KindEdit {
		t.Error("protocol edit not detected")
	}
	e = ev(&waE2E.Message{Conversation: proto.String("hi")})
	e.Info.Chat = types.NewJID("12345", types.HiddenUserServer)
	e.Info.Sender = types.NewJID("12345", types.HiddenUserServer)
	if m := mapMessage(nil, e); m.Sender != "" || m.ChatServer != "lid" {
		t.Errorf("lid without alt: %+v", m)
	}
	e.Info.SenderAlt = types.NewJID("254700000009", types.DefaultUserServer)
	if m := mapMessage(nil, e); m.Sender != "254700000009" {
		t.Errorf("lid alt not used: %+v", m)
	}
}
